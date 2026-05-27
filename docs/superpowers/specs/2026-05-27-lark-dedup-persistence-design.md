# 设计:Lark 入站消息去重持久化

- 日期:2026-05-27
- 状态:已批准设计,待写实现计划
- 范围:`@craft-agent/messaging-gateway` 的 Lark 适配器
- 相关代码:`packages/messaging-gateway/src/adapters/lark/index.ts`、`packages/messaging-gateway/src/registry.ts`
- 模板参考:`packages/messaging-gateway/src/pending-senders.ts`、`topic-registry.ts`

## 1. 背景与问题

Lark 通过 `@larksuiteoapi/node-sdk` 的 `WSClient` 长连接推送事件,采用 **at-least-once(至少一次)** 投递:客户端处理完一条事件后,沿同一连接回一个 `code:200` 的 response 帧作为回执(见 `lib/index.js` 的 `handleEventData`)。一旦连接在回执送达前中断,服务端无法区分"未收到 / 收到未处理 / 已处理但回执丢失"三种情况,为保证不丢消息,会在重连后**重投这些未确认的事件**(以及断线期间积压的事件)。

适配器目前用一个**内存** `Set<string>`(`seenMessageIds`,`DEDUP_MAX = 1000` 计数 LRU)按 `message_id` 去重(`adapters/lark/index.ts:303`、`:820` 检查、`:828` 记录)。但该 Set 在 `destroy()` 中被 `clear()`(`:458`)。

关键事实:`WSClient` 内部自动重连**不会**销毁适配器,所以纯网络重连时内存去重仍在、重复会被挡住。**真正丢失去重记忆的是进程重启 / 适配器重建**(部署、崩溃、重启机器)——此时新适配器的 Set 为空,Lark 重投的历史事件全部通过 `has()` 检查被当作新消息重新处理,导致 **agent 把历史问题"再问 / 再答一遍"**。

该缺口随 commit `d90c610`(“Fix Lark message acknowledgements”,2026-05-26)引入:该提交首次加入内存去重 + 表情回执,修好了运行期重复,但去重实现为内存态且 `destroy()` 清空,未覆盖"进程重启后重投"。

## 2. 目标与非目标

**目标**
- 让 Lark 入站消息去重**跨进程重启存活**,消除重启后"历史问题再问一遍"。
- 保持现有语义:**收到即记**(在分发前标记 `message_id`),失败不重试(已与需求方确认)。
- 紧贴既有 messaging-gateway 存储写法,改动最小、隔离可测。

**非目标**
- 不做网关层平台无关的通用去重(Telegram 走 offset ack、WhatsApp 另有机制,均不受此 bug 影响)。
- 不做多服务器实例共享的分布式去重(无外部存储依赖)。
- 不改变"快速回执 + 异步跑回合"的处理模型。

## 3. 已定决策

| 决策点 | 选择 |
|---|---|
| 范围 | 仅 Lark 适配器 |
| 失败语义 | 收到即记、不重试(维持当前行为) |
| 持久化方式 | 专用文件存储,仿 `PendingSendersStore` |
| 有界策略 | TTL 为主(**48h**)+ 计数上限兜底(**50000**) |
| 注入方式 | Lark 专属构造参数(不改 `PlatformAdapter` 公共接口) |
| 文件名 | `lark-seen.json`(放 per-workspace messaging 目录) |

> TTL=48h 是相对 Lark 重投窗口的保守值;若后续确认了官方重投窗口的确切上限,可下调。计数上限仅作极端膨胀的兜底,正常由 TTL 主导。

## 4. 详细设计

### 4.1 新组件 `SeenMessageStore`

新文件 `packages/messaging-gateway/src/seen-message-store.ts`,结构对标 `pending-senders.ts` / `topic-registry.ts`。

```ts
const TTL_MS = 48 * 60 * 60 * 1000   // 48 小时
const MAX_ENTRIES = 50_000           // 兜底上限

export class SeenMessageStore {
  private entries = new Map<string, number>() // message_id -> firstSeenAt(ms)
  private readonly filePath: string
  private readonly dirPath: string
  private readonly log: MessagingLogger
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(storageDir: string, logger?: MessagingLogger) {
    this.dirPath = storageDir
    this.filePath = join(storageDir, 'lark-seen.json')
    this.log = logger ?? NOOP_LOGGER
    this.load()
  }

  /** 是否已见过(且未过期) */
  has(messageId: string): boolean

  /** 记录已见;清过期、必要时按最旧淘汰至上限;防抖落盘 */
  add(messageId: string): void

  /** 启动加载:读 JSON,加载时即剪枝过期项 */
  private load(): void

  /** 防抖写盘(突发消息合并写一次) */
  private scheduleSave(): void
  private save(): void

  private evict(now: number): void // 先删过期,再超限删最旧
}
```

- **内存索引**:`Map<message_id, firstSeenAt>`,`has` 为 O(1) 且顺带判 TTL。
- **磁盘格式**:`lark-seen.json` 存 `Array<[id, ts]>`(或 `{ entries: [...] }`),`load()` 时按 `now - ts < TTL_MS` 过滤。
- **落盘时机**:`add` 后 `scheduleSave()` 防抖(如 500ms 合并),避免突发消息抖盘。

### 4.2 接线 / 数据流

- 在 `registry.ts` 创建 Lark 适配器处(约 `:1096` `new LarkAdapter()`):
  ```ts
  const seenStore = new SeenMessageStore(this.opts.getMessagingDir(workspaceId), logger)
  const adapter = new LarkAdapter(seenStore)
  ```
  复用既有的 `getMessagingDir(workspaceId)`(同 `PendingSendersStore` 等,`registry.ts:994`)。
  - **实现注意**:确认 `workspaceId` 在该构造点在作用域内;若不在,需从该方法上游透传(实现计划阶段确认)。
- `LarkAdapter` 增加可选构造参数 `constructor(seenStore?: SeenMessageStore)`。未注入时回退到一个仅内存的实现(保持测试与边缘场景可用)。

### 4.3 适配器改动(`adapters/lark/index.ts`)

- 删除 `private seenMessageIds = new Set<string>()`(`:303`)与 `DEDUP_MAX` 计数 LRU(`rememberMessageId`,`:1096-1107`),改为持有 `seenStore`。
- `handleIncomingMessage`(`:820`):
  - `if (this.seenStore.has(message.message_id)) { …丢弃重复日志… return }`
  - 在分发前 `this.seenStore.add(message.message_id)`(替换 `:828` 的 `rememberMessageId`)。**语义不变:收到即记。**
- `destroy()`(`:458`):**移除 `seenMessageIds.clear()`**。改为确保已落盘(`flush`)后丢弃内存引用;磁盘文件保留 → 下次 `initialize`/构造时 `load()` 恢复 → **扛住进程重启**。

### 4.4 错误处理

- `load()` 遇文件缺失/损坏:`log.warn` + 空起步(同 `PendingSendersStore` 的 load 容错),最坏退化为"当前内存行为",不抛、不崩。
- `save()` 失败:`log.warn` + 保留内存数据,**绝不把异常抛入消息处理路径**——去重失败不得拖垮路由/回执。
- 并发:单进程、单适配器,写经防抖串行化,无竞争。

### 4.5 测试

- `SeenMessageStore` 单测(新 `seen-message-store.test.ts`):
  - `add` 后 `has` 为真;未 add 为假。
  - **TTL 过期**:超过 `TTL_MS` 的项 `has` 返回假,且 `load`/`evict` 会剪除。
  - **持久化往返**:实例 A `add` 并落盘 → 指向同目录的实例 B `load` 后 `has` 为真(**模拟重启**)。
  - 计数上限:超过 `MAX_ENTRIES` 时淘汰最旧。
  - 损坏文件:`load` 不抛、空起步。
- 适配器测(扩 `lark-adapter.test.ts` 现有 “drops duplicate” 用例):同一 `message_id` 投递给"指向同一存储目录的新适配器实例"→ 第二次被丢弃(覆盖重启路径)。

## 5. 备选方案(未采纳)

- **方案 B:在 router/session 消费端做幂等。** 借会话 JSONL 持久化天然扛重启,更接近"幂等消费"本质;但耦合 session 生命周期(session 建立前到达的消息盖不住)、每条入站要查会话状态更重、改动跨层,**超出"只修 Lark、最小改动"范围**。
- **方案 C:把现有内存 Set 直接落盘(最小补丁)。** diff 最小;但本质是方案 A 的简化版,缺 TTL/有界/复用既有 store 模式的整洁,不加裁剪文件会无限增长。可作为方案 A 的退路。

## 6. 后续 / 风险

- 若将来上多实例部署,需要把去重状态迁到共享存储(Redis 等)——本设计不覆盖,但 `SeenMessageStore` 的接口(`has`/`add`)足够小,届时可替换实现。
- 若 Lark 官方重投窗口确切值已知,可据此下调 `TTL_MS`。
- 多 workspace 各自一份 `lark-seen.json`(因 messaging 目录按 workspace 隔离);`message_id` 在 Lark 全局唯一,单 workspace 一份去重表正确。
