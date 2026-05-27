# Lark 入站去重持久化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Lark 适配器的入站消息去重持久化到磁盘,使其在进程重启后仍生效,消除"Lark 重投历史事件 → agent 再问一遍"。

**Architecture:** 新增一个文件级持久化存储 `SeenMessageStore`(仿 `PendingSendersStore`,TTL + 防抖落盘),Lark 适配器用它替换原内存 `Set<string>`,并把 `destroy()` 里的 `clear()` 改为 `flush()`(落盘而非清空)。在 `registry.ts` 构造 Lark 适配器处用 per-workspace messaging 目录创建该 store 并注入。

**Tech Stack:** TypeScript、Bun(`bun test` / `bun run typecheck`)、`node:fs`(与既有 `pending-senders.ts` 一致)。

**Spec:** `docs/superpowers/specs/2026-05-27-lark-dedup-persistence-design.md`

---

## 执行前置(重要)

工作树中 `packages/messaging-gateway/src/adapters/lark/index.ts` 与 `src/__tests__/lark-adapter.test.ts` **已有未提交改动**(Lark 附件功能,与本改动正交)。本计划也要改这两个文件,因此:

- **每个 commit 步骤只 `git add` 本任务明确列出的文件**,绝不用 `git add -A` / `git add .`,以免把未完成的附件 WIP 一起提交。
- 任务 2 修改的 `lark/index.ts` / `lark-adapter.test.ts` 与 WIP 在同一文件:`git add <文件>` 会把该文件中的 WIP 改动一并暂存。**执行任务 2 的提交前,请先与用户确认**:要么用户先提交/暂存其附件 WIP,要么接受该 commit 含入这些文件的全部当前改动。计划默认按"用户已先处理 WIP"推进。

---

## File Structure

- **Create** `packages/messaging-gateway/src/seen-message-store.ts` — 持久化去重存储(单一职责:按 message_id 记忆"已见",TTL + 上限 + 落盘)。
- **Create** `packages/messaging-gateway/src/seen-message-store.test.ts` — 该存储的单测(与 `binding-store.test.ts` 同为 src 内同级测试)。
- **Modify** `packages/messaging-gateway/src/adapters/lark/index.ts` — 用 store 替换内存 Set;新增构造参数;`destroy()` 改 flush;移除 `DEDUP_MAX` / `rememberMessageId`。
- **Modify** `packages/messaging-gateway/src/__tests__/lark-adapter.test.ts` — 新增"跨实例(重启)去重"测试。
- **Modify** `packages/messaging-gateway/src/registry.ts` — 构造 `SeenMessageStore` 并注入 `LarkAdapter`。

---

## Task 1: 新建 `SeenMessageStore`(持久化去重存储)

**Files:**
- Create: `packages/messaging-gateway/src/seen-message-store.ts`
- Test: `packages/messaging-gateway/src/seen-message-store.test.ts`

- [ ] **Step 1: 写失败测试**

写入 `packages/messaging-gateway/src/seen-message-store.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SeenMessageStore } from './seen-message-store'

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'lark-seen-'))
}

describe('SeenMessageStore', () => {
  it('records and recognizes message ids (in-memory mode)', () => {
    const store = new SeenMessageStore()
    expect(store.has('m1')).toBe(false)
    store.add('m1')
    expect(store.has('m1')).toBe(true)
    expect(store.has('m2')).toBe(false)
  })

  it('persists across instances (survives restart)', () => {
    const dir = tmpDir()
    const a = new SeenMessageStore(dir)
    a.add('m1')
    a.add('m2')
    a.flush()
    expect(existsSync(join(dir, 'lark-seen.json'))).toBe(true)

    const b = new SeenMessageStore(dir)
    expect(b.has('m1')).toBe(true)
    expect(b.has('m2')).toBe(true)
    expect(b.has('m3')).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('prunes entries older than the TTL on load', () => {
    const dir = tmpDir()
    const now = Date.now()
    const stale = now - 49 * 60 * 60 * 1000 // older than 48h default
    writeFileSync(
      join(dir, 'lark-seen.json'),
      JSON.stringify([['old', stale], ['fresh', now]]),
      'utf-8',
    )
    const store = new SeenMessageStore(dir)
    expect(store.has('old')).toBe(false)
    expect(store.has('fresh')).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('expires entries at runtime once past the TTL', async () => {
    const store = new SeenMessageStore(undefined, undefined, { ttlMs: 10 })
    store.add('m1')
    expect(store.has('m1')).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(store.has('m1')).toBe(false)
  })

  it('evicts the oldest entries past the cap', () => {
    const store = new SeenMessageStore(undefined, undefined, { maxEntries: 3 })
    store.add('a')
    store.add('b')
    store.add('c')
    store.add('d') // overflow → 'a' evicted
    expect(store.has('a')).toBe(false)
    expect(store.has('b')).toBe(true)
    expect(store.has('c')).toBe(true)
    expect(store.has('d')).toBe(true)
  })

  it('recovers from a corrupt file by starting empty', () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'lark-seen.json'), 'not-json{', 'utf-8')
    const store = new SeenMessageStore(dir)
    expect(store.has('anything')).toBe(false)
    store.add('m1')
    expect(store.has('m1')).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `cd packages/messaging-gateway && bun test src/seen-message-store.test.ts`
Expected: FAIL —— 形如 `Cannot find module './seen-message-store'`。

- [ ] **Step 3: 写最小实现**

写入 `packages/messaging-gateway/src/seen-message-store.ts`:

```ts
/**
 * SeenMessageStore — persistent dedup of Lark inbound message_ids.
 *
 * Lark's WSClient delivers events at-least-once: on reconnect or process
 * restart it redelivers un-acknowledged / buffered events. The Lark adapter
 * drops duplicates by message_id, but its previous in-memory Set was wiped on
 * process restart, so redelivered historical events were re-processed (the
 * agent "re-asked" old questions). This store persists seen message_ids to
 * `{storageDir}/lark-seen.json` so dedup survives restarts.
 *
 * Bounds:
 *  - TTL (default 48h): entries older than that are pruned on load / access.
 *  - Hard cap (default 50000): oldest entries evicted on overflow.
 *  - File-backed best-effort. A corrupt/missing file resets to empty (at worst
 *    a brief window of duplicates).
 *  - storageDir omitted → in-memory only (test / fallback mode).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MessagingLogger } from './types'

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000 // 48 hours
const DEFAULT_MAX_ENTRIES = 50_000
const SAVE_DEBOUNCE_MS = 500

export interface SeenMessageStoreOptions {
  ttlMs?: number
  maxEntries?: number
}

export class SeenMessageStore {
  /** message_id -> firstSeenAt (epoch ms). Map insertion order = age order. */
  private entries = new Map<string, number>()
  private readonly filePath: string | null
  private readonly dirPath: string | null
  private readonly log: MessagingLogger
  private readonly ttlMs: number
  private readonly maxEntries: number
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    storageDir?: string,
    logger: MessagingLogger = NOOP_LOGGER,
    opts?: SeenMessageStoreOptions,
  ) {
    this.dirPath = storageDir ?? null
    this.filePath = storageDir ? join(storageDir, 'lark-seen.json') : null
    this.log = logger
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS
    this.maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.load()
  }

  /** True if this message_id was already seen and has not expired. */
  has(messageId: string): boolean {
    const ts = this.entries.get(messageId)
    if (ts === undefined) return false
    if (Date.now() - ts >= this.ttlMs) {
      this.entries.delete(messageId)
      return false
    }
    return true
  }

  /** Record a message_id as seen (mark-on-receipt). No-op if already present. */
  add(messageId: string): void {
    if (this.entries.has(messageId)) return
    this.entries.set(messageId, Date.now())
    this.evict(Date.now())
    this.scheduleSave()
  }

  /** Force any pending write to disk now. Call on shutdown. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.save()
  }

  private evict(now: number): void {
    const cutoff = now - this.ttlMs
    for (const [id, ts] of this.entries) {
      if (ts < cutoff) this.entries.delete(id)
    }
    if (this.entries.size > this.maxEntries) {
      const overflow = this.entries.size - this.maxEntries
      let removed = 0
      for (const id of this.entries.keys()) {
        this.entries.delete(id)
        if (++removed >= overflow) break
      }
    }
  }

  private load(): void {
    if (!this.filePath) return
    try {
      if (!existsSync(this.filePath)) return
      const raw = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return
      const cutoff = Date.now() - this.ttlMs
      for (const item of parsed) {
        if (
          Array.isArray(item) &&
          typeof item[0] === 'string' &&
          typeof item[1] === 'number' &&
          item[1] >= cutoff
        ) {
          this.entries.set(item[0], item[1])
        }
      }
    } catch (err) {
      this.log.warn('failed to load seen messages; resetting', {
        event: 'lark_seen_load_failed',
        filePath: this.filePath,
        error: err,
      })
      this.entries.clear()
    }
  }

  private scheduleSave(): void {
    if (!this.filePath || this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.save()
    }, SAVE_DEBOUNCE_MS)
  }

  private save(): void {
    if (!this.filePath || !this.dirPath) return
    try {
      if (!existsSync(this.dirPath)) {
        mkdirSync(this.dirPath, { recursive: true })
      }
      writeFileSync(this.filePath, JSON.stringify([...this.entries.entries()]), 'utf-8')
    } catch (err) {
      this.log.warn('failed to save seen messages', {
        event: 'lark_seen_save_failed',
        filePath: this.filePath,
        error: err,
      })
    }
  }
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `cd packages/messaging-gateway && bun test src/seen-message-store.test.ts`
Expected: PASS(6 个用例全过)。

- [ ] **Step 5: 提交**

```bash
git add packages/messaging-gateway/src/seen-message-store.ts packages/messaging-gateway/src/seen-message-store.test.ts
git commit -m "$(cat <<'EOF'
Add SeenMessageStore for persistent Lark dedup.

File-backed store (TTL + bounded) so seen message_ids survive process
restart. Not yet wired into the adapter.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 在 `LarkAdapter` 中使用该 store

**Files:**
- Modify: `packages/messaging-gateway/src/adapters/lark/index.ts`
- Test: `packages/messaging-gateway/src/__tests__/lark-adapter.test.ts`

> 行号以当前工作树为准(含你的附件 WIP),可能有偏移;请按**代码内容**定位,行号仅作提示。

- [ ] **Step 1: 写失败测试**

在 `packages/messaging-gateway/src/__tests__/lark-adapter.test.ts` 顶部确保以下导入存在(与现有/WIP 的 `node:fs` 导入**合并**,只新增本测试用到的符号 `mkdtempSync`、`rmSync`,以及 os/path/store):

```ts
import { mkdtempSync, rmSync } from 'node:fs' // 并入现有 node:fs 导入行
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SeenMessageStore } from '../seen-message-store'
```

> 现有文件已从 `node:fs` 导入 `readFileSync`;把 `mkdtempSync, rmSync` 并入同一行即可——**勿重复声明、勿引入未使用的符号**(否则 `bun run typecheck` 可能因 `noUnusedLocals` 报错)。

在 `describe('LarkAdapter — static contract', ...)` 内、现有 `'drops duplicate inbound message events by Lark message_id'` 用例之后,新增:

```ts
  it('persists dedup across adapter instances via a shared SeenMessageStore', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-adapter-seen-'))

    const buildAdapter = () => {
      const adapter = new LarkAdapter(new SeenMessageStore(dir))
      const received: IncomingMessage[] = []
      adapter.onMessage(async (msg) => {
        received.push(msg)
      })
      const handle = (
        adapter as unknown as {
          handleIncomingMessage: (event: {
            sender: { sender_id: { open_id: string } }
            message: {
              message_id: string
              chat_id: string
              chat_type: string
              message_type: string
              content: string
              create_time: string
            }
          }) => Promise<void>
        }
      ).handleIncomingMessage.bind(adapter)
      return { adapter, received, handle }
    }

    const event = {
      sender: { sender_id: { open_id: 'ou_1' } },
      message: {
        message_id: 'om_persist',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
        create_time: '1779782400000',
      },
    }

    // 第一个实例处理消息,然后 destroy() —— 触发 flush 落盘。
    const first = buildAdapter()
    await first.handle(event)
    expect(first.received).toHaveLength(1)
    await first.adapter.destroy()

    // 第二个实例(模拟进程重启)必须丢弃被重投的同一事件。
    const second = buildAdapter()
    await second.handle(event)
    expect(second.received).toHaveLength(0)

    rmSync(dir, { recursive: true, force: true })
  })
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `cd packages/messaging-gateway && bun test src/__tests__/lark-adapter.test.ts`
Expected: FAIL —— `new LarkAdapter(new SeenMessageStore(dir))` 处类型/参数报错(当前构造函数不接收参数),或第二实例 `received` 长度为 1(去重未持久化)。

- [ ] **Step 3: 改实现 —— 引入 store**

在 `packages/messaging-gateway/src/adapters/lark/index.ts`:

(a) 顶部导入区(`'./card'` 导入块之后)新增:

```ts
import { SeenMessageStore } from '../../seen-message-store'
```

(b) 删除常量 `const DEDUP_MAX = 1000`(约第 48 行)。

(c) 把字段声明 `private seenMessageIds = new Set<string>()`(约第 303 行)替换为下面的字段 + 构造函数(放在 `receivedReactionIds` 字段之后、`markMessageReceived` 方法之前):

```ts
  private readonly seenStore: SeenMessageStore

  constructor(seenStore?: SeenMessageStore) {
    // storageDir omitted → in-memory only (keeps no-arg construction working
    // for tests and as a safe fallback when no messaging dir is available).
    this.seenStore = seenStore ?? new SeenMessageStore()
  }
```

(d) 在 `handleIncomingMessage` 内,把去重检查与记录(约第 820 / 828 行)改为走 store:

```ts
    if (this.seenStore.has(message.message_id)) {
      this.log.info('[lark] dropped duplicate event', {
        event: 'lark_duplicate_event',
        chatId: message.chat_id,
        messageId: message.message_id,
      })
      return
    }
    this.seenStore.add(message.message_id)
```

(e) 在 `destroy()` 内,把 `this.seenMessageIds.clear()`(约第 458 行)替换为(持久化、不清空):

```ts
    this.seenStore.flush()
```

(f) 删除整个 `private rememberMessageId(messageId: string): void { ... }` 方法(约第 1096–1107 行)。

- [ ] **Step 4: 运行测试,确认通过**

Run: `cd packages/messaging-gateway && bun test src/__tests__/lark-adapter.test.ts`
Expected: PASS —— 新增的"跨实例去重"用例通过,且既有 `'drops duplicate inbound message events by Lark message_id'`(同实例内存去重)仍通过。

- [ ] **Step 5: 提交**

> 见"执行前置":确认已处理附件 WIP 后再提交。仅暂存这两个文件。

```bash
git add packages/messaging-gateway/src/adapters/lark/index.ts packages/messaging-gateway/src/__tests__/lark-adapter.test.ts
git commit -m "$(cat <<'EOF'
Use persistent SeenMessageStore in Lark adapter.

Replace the in-memory dedup Set with SeenMessageStore and flush (not clear)
on destroy, so redelivered events are still deduped after a process restart.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 在 `registry.ts` 接线并整体验证

**Files:**
- Modify: `packages/messaging-gateway/src/registry.ts`

- [ ] **Step 1: 加导入**

在 `registry.ts` 顶部导入区新增:

```ts
import { SeenMessageStore } from './seen-message-store'
```

- [ ] **Step 2: 构造 store 并注入适配器**

定位 Lark 适配器构造处(约第 1096 行 `const adapter = new LarkAdapter()`,其上有 `await state.gateway.unregisterAdapter('lark')...`)。把:

```ts
      const adapter = new LarkAdapter()
```

替换为:

```ts
      const seenStore = new SeenMessageStore(
        this.opts.getMessagingDir(workspaceId),
        this.log.child({ component: 'lark-seen-store', workspaceId, platform: 'lark' }),
      )
      const adapter = new LarkAdapter(seenStore)
```

(`workspaceId` 在该方法作用域内可用;`this.opts.getMessagingDir` 见 `registry.ts:73`,与 `PendingSendersStore` 等用法一致。)

- [ ] **Step 3: 类型检查**

Run: `cd packages/messaging-gateway && bun run typecheck`
Expected: PASS —— 无类型错误。

- [ ] **Step 4: 跑整个 messaging-gateway 测试套件**

Run: `cd packages/messaging-gateway && bun test`
Expected: PASS —— 全部用例通过(含 `seen-message-store.test.ts`、`lark-adapter.test.ts` 及既有用例;不得有回归)。

- [ ] **Step 5: 提交**

```bash
git add packages/messaging-gateway/src/registry.ts
git commit -m "$(cat <<'EOF'
Wire per-workspace SeenMessageStore into Lark adapter setup.

Construct the store from the workspace messaging dir and inject it, so Lark
dedup is durable across restarts in real (registry-driven) runs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 验收标准

- `SeenMessageStore` 单测 6 项全过;`lark-adapter.test.ts` 新"跨实例去重"用例过、既有用例不回归。
- `bun run typecheck` 与 `bun test`(messaging-gateway)全绿。
- 行为:进程重启后,Lark 重投的历史 `message_id` 被 `lark-seen.json` 命中并丢弃,agent 不再"再问一遍";网络重连场景仍由内存命中挡住(语义不变:收到即记)。
