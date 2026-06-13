# 上游同步记录

本文件记录本仓库（fork：`chuangwei/my-agents-oss`）从上游 `craft-ai-agents/craft-agents-oss` 同步更新的历史，便于追溯每次合并带来的变更及冲突处理方式。

> 同步方式：`git fetch upstream` → `git merge upstream/main --no-ff -m "Merge upstream vX.Y.Z"`，本地自定义提交（CI、打包修复、WeChat/Lark 适配器等）始终保留。

---

## 2026-06-13 — 同步至 v0.10.3

- **合并提交**：`Merge upstream v0.10.3`
- **拉取版本**：`v0.10.2`、`v0.10.3`（含标签）
- **冲突处理**：仅 `bun.lock` 冲突，通过 `bun install` 重新生成锁文件解决；其余文件自动合并成功。
- **校验**：`bun run typecheck:shared` 通过。

### v0.10.3 — Claude Fable 5

- **新增 Claude Fable 5 模型**：Anthropic 目前最强的正式发布模型（GA 2026-06-09），在 Claude Agent SDK 路径可用，支持 100 万 token 上下文窗口；覆盖直连 Anthropic 与 AWS Bedrock（us/eu/global 推理配置），模型描述已本地化为全部 7 种语言。默认模型仍为 Opus 4.8，Fable 作为并列选项提供。针对 Fable 5 / Mythos 5 这类「自适应思考常开、拒绝显式关闭」的模型，思考解析器将「off」与最小化思考映射为低强度自适应思考；Opus、Sonnet、Haiku 行为完全不变。
- **Claude Agent SDK 升级**：`@anthropic-ai/claude-agent-sdk` 从 `0.3.154` → `0.3.170`（根包及 core、shared 对等依赖，锁文件已刷新），无 API 破坏，typecheck 通过。

### v0.10.2 — 链接型标签、Anthropic 账号可见性、prompt 缓存修复

**功能**

- **链接型标签值**：标签新增 `link` 值类型，渲染为可点击的 chip（展示时去除 URL scheme），点击在外部浏览器打开，值弹窗中提供键盘可达的「打开链接」操作；贯通 zod schema、CLI 与 agent-prompt 层。
- **每个 OAuth 连接显示解析出的 Anthropic 账号与组织**：设置 → LLM Connections 中显示每个 Claude OAuth 授权解析到的真实身份（「邮箱 · 组织」）。当同一工作区两个连接解析到**同一** Anthropic 账号（共享配额，此前不可见的错配）时，给出琥珀色警告。同时修复了 `updateLlmConnection` 因硬编码字段白名单而在每次保存时静默丢弃未列字段的隐患（#838）。
- **Stop 时恢复上次发送的消息到输入框**：点击 Stop（显式取消）会把上次发送的消息回填到输入框以便修改重发；对运行中已输入的草稿安全追加。

**Bug 修复**

- **Pi prompt 缓存不再每轮失效**：将 `PromptBuilder.buildContextParts` 拆分为 `buildVolatileContextParts` + `buildStableContextParts`；Pi 路径仅在缓存前缀保留稳定块（工作区能力、工作目录），易变块（分钟级时间、`session_state` 等）路由到用户消息尾部，与 Claude 路径一致。Claude 路径字节不变（#862）。
- **Accept-Plan 箭头在下拉打开时正确旋转**：将旋转作用域绑定到按钮的命名 group，修复 Radix `asChild` 导致 `data-state` 落在宿主 `<button>` 而非嵌套 `<svg>` 的问题（#840）。

---

<!-- 后续同步请按上方格式在此追加新条目，最新的放在最前。 -->
