# Craft Agents Electron 应用

[English](README.md)

Craft Agents 的主要桌面界面，基于 Electron + React 构建。它提供多会话收件箱和聊天界面，用于通过 Craft 工作区与 Claude 交互。

## 快速开始

```bash
# 从项目根目录执行
bun run electron:build   # 构建应用
bun run electron:start   # 构建并运行
```

## 架构

```text
apps/electron/
├── src/
│   ├── main/              # Electron 主进程
│   │   ├── index.ts       # 窗口创建、应用生命周期
│   │   ├── ipc.ts         # IPC 处理器注册
│   │   ├── menu.ts        # 应用菜单（文件、编辑、视图、帮助）
│   │   ├── sessions.ts    # 会话管理、CraftAgent 集成
│   │   ├── deep-link.ts   # Deep link URL 解析和处理
│   │   ├── agent-service.ts # Agent 列表、缓存、鉴权检查
│   │   └── sources-service.ts # Source 和认证服务
│   ├── preload/           # 上下文桥接（main ↔ renderer）
│   │   └── index.ts       # 暴露 electronAPI 给渲染进程
│   ├── renderer/          # React UI
│   │   ├── App.tsx        # 主应用、事件处理
│   │   ├── components/
│   │   │   ├── chat/      # 聊天 UI（ChatInput、ChatDisplay）
│   │   │   ├── markdown/  # 使用 Shiki 的 Markdown 渲染器
│   │   │   └── ui/        # shadcn/ui 组件（包括 source-avatar.tsx）
│   │   ├── contexts/
│   │   │   └── NavigationContext.tsx  # 类型安全的路由和导航
│   │   ├── lib/
│   │   │   └── navigate.ts  # 全局 navigate() 函数
│   │   ├── hooks/
│   │   │   └── useAgentState.ts  # Agent 激活状态机
│   │   └── playground/    # 组件开发 playground
│   └── shared/
│       ├── types.ts       # 共享 TypeScript 接口
│       ├── routes.ts      # 类型安全的路由定义
│       └── route-parser.ts # 路由字符串解析
├── dist/                  # 构建输出
└── resources/             # 应用图标
```

## 关键经验与注意事项

### 1. SDK 路径解析（重要）

Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）会启动一个运行 `cli.js` 的子进程。当 esbuild 把 SDK 打包进 `main.js` 后，SDK 对 `cli.js` 的自动探测会失效。

**问题：**

```text
Error: The "path" argument must be of type string or an instance of URL. Received undefined
```

**根因：** SDK 使用 `import.meta.url` 来查找 `cli.js`。打包后，这个路径不再有效。

**解决方案：** 在创建任何 agent 之前显式设置路径：

```typescript
import { setPathToClaudeCodeExecutable } from '../../../src/agent/options'

// In initialize():
const cliPath = join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js')
setPathToClaudeCodeExecutable(cliPath)
```

### 2. 认证环境设置（重要）

SDK 要求在创建 agent 之前设置认证环境变量。Electron 应用必须在初始化期间显式完成这一步。

```typescript
import { getAuthState } from '../../../src/auth/state'

// In initialize():
const authState = await getAuthState()
const { billing } = authState

if (billing.type === 'oauth_token' && billing.claudeOAuthToken) {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = billing.claudeOAuthToken
} else if (billing.apiKey) {
  process.env.ANTHROPIC_API_KEY = billing.apiKey
}
```

### 3. AgentEvent 类型差异

`CraftAgent` 的 `AgentEvent` 类型使用的属性名可能和直觉不同：

| 事件类型 | 错误写法 | 正确写法 |
| --- | --- | --- |
| `text_delta` | `event.delta` | `event.text` |
| `error` | `event.error` | `event.message` |
| `tool_result` | `event.toolName` | 只有 `event.toolUseId` |

**`tool_result` 的解决方案：** 从 `tool_start` 事件中维护 `toolUseId → toolName` 映射：

```typescript
interface ManagedSession {
  // ...
  pendingTools: Map<string, string>  // toolUseId -> toolName
}

// In tool_start handler:
managed.pendingTools.set(event.toolUseId, event.toolName)

// In tool_result handler:
const toolName = managed.pendingTools.get(event.toolUseId) || 'unknown'
managed.pendingTools.delete(event.toolUseId)
```

### 4. CraftAgent 构造函数

`CraftAgent` 需要完整的 `Workspace` 对象，而不只是 ID：

```typescript
// Wrong:
new CraftAgent({ workspaceId: workspace.id, model })

// Correct:
new CraftAgent({ workspace, model })
```

### 5. esbuild 配置

只有 `electron` 被 externalize。SDK 会被打包进 `main.js`：

```json
"electron:build:main": "esbuild ... --external:electron"
```

这意味着：

- SDK 代码会被内联（约 950KB）
- SDK 的运行时路径解析会失效（见第 1 点）
- 原生模块需要显式 externalize

## 环境变量

### Gmail OAuth（通过 1Password CLI）

Gmail OAuth 凭证会从 1Password 同步到本地 `.env` 文件。

**一次性设置：**

```bash
# 1. 安装 1Password CLI
brew install 1password-cli

# 2. 开启 CLI 集成：1Password app → Settings → Developer → CLI Integration

# 3. 同步密钥（需要一次 Touch ID）
bun run sync-secrets
```

**就这样。** 之后 `bun run electron:dev` 和 `bun run electron:start` 都可以无提示运行。

**工作原理：**

- `.env.1password` 包含指向 `Dev_Craft_Agents` vault 的 `op://` 引用
- `bun run sync-secrets` 解析这些引用并写入 `.env`（已被 git 忽略）
- 密钥会通过 esbuild 的 `--define` 标志在编译时写入构建产物

**创建自己的 OAuth 凭证：**

1. 打开 [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials
2. 创建 OAuth Client ID（Desktop app 类型）
3. 在 OAuth consent screen 中启用所需 scopes：
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/userinfo.email`

## 构建流程

```bash
bun run electron:build:main      # 打包主进程（esbuild）
bun run electron:build:preload   # 打包 preload 脚本（esbuild）
bun run electron:build:renderer  # 打包 React 应用（Vite）
bun run electron:build:resources # 复制图标
bun run electron:build           # 执行以上所有步骤
```

## macOS Liquid Glass 图标

应用包含一个为 macOS 26+ Liquid Glass 图标准备的预编译 `Assets.car`。这会在 macOS Tahoe 上启用分层玻璃效果。在更旧的 macOS 版本上，应用会回退到 `icon.icns`。

**图标变更后的重新生成：**

如果修改了 `resources/icon.icon`，请重新生成 Assets.car：

```bash
cd apps/electron
xcrun actool "resources/icon.icon" --compile "resources" \
  --app-icon AppIcon --minimum-deployment-target 26.0 \
  --platform macosx --output-partial-info-plist /dev/null
```

> **注意：** 这需要带有 Xcode 26（macOS 26 SDK）的 macOS 26。预编译的 Assets.car 已提交到仓库，因此 CI 构建不需要该 SDK。

## 调试

要启用控制台日志，请查看运行 `electron:start` 的终端。关键日志前缀：

- `[SessionManager]` - 会话生命周期、认证设置
- `[IPC]` - 进程间通信

DevTools 会自动打开（在 `index.ts` 中配置）。生产环境请移除 `mainWindow.webContents.openDevTools()`。

## 当前限制

1. **仅限开发环境** - 尚无用于分发的 electron-builder 配置

## 已实现功能

- **会话持久化** - 会话、消息和名称会保存到磁盘
- **文件附件** - 可将图片、PDF 和代码文件附加到消息
- **AI 生成标题** - 第一次交互后自动为会话生成标题
- **Subagent 支持** - 从 Craft 文档加载并应用 agent 定义
- **Shell 集成** - 在浏览器中打开 URL、用默认应用打开文件
- **权限模式** - 三层权限系统（Explore、Ask to Edit、Auto）
- **后台任务** - 在后台运行长任务并跟踪进度
- **多文件 diff** - 用类似 VS Code 的窗口查看单轮对话中的所有文件变更
- **动态状态** - 工作区可自定义的会话工作流状态
- **主题系统** - 级联主题（应用 → 工作区 → agent）
- **Agent 状态机** - `useAgentState` hook 管理激活流程
- **应用菜单** - 带键盘快捷键的标准 macOS/Windows 菜单
- **组件 playground** - 用于隔离测试 UI 组件的开发工具
- **类型安全导航** - 面向标签页、动作和 deep link 的统一路由系统

## 导航系统

应用为所有内部导航和 deep link 使用类型安全的路由系统。

### 快速开始

```typescript
import { navigate, routes } from '@/lib/navigate'

// Tab routes
navigate(routes.tab.settings())           // Open settings
navigate(routes.tab.chat('session123'))   // Open chat
navigate(routes.tab.agentInfo('claude'))  // Open agent info

// Action routes
navigate(routes.action.newChat({ agentId: 'claude' }))  // New chat with agent
navigate(routes.action.deleteSession('id'))             // Delete session

// Sidebar routes
navigate(routes.sidebar.inbox())          // Show inbox
navigate(routes.sidebar.flagged())        // Show flagged
```

### Deep Links

外部应用可以使用 `craftagents://` URL 进行导航：

```text
craftagents://settings
craftagents://allSessions/session/session123
craftagents://sources/source/github
craftagents://action/new-chat
craftagents://workspace/{id}/allSessions/session/abc123
```

完整路由参考见 `CLAUDE.md`。

## 文件概览

| 文件 | 用途 |
| --- | --- |
| `main/index.ts` | 应用入口、窗口创建 |
| `main/sessions.ts` | CraftAgent 包装器、事件处理、source 集成 |
| `main/ipc.ts` | IPC channel 处理器（会话、文件、shell） |
| `main/menu.ts` | 应用菜单（文件、编辑、视图、帮助） |
| `main/deep-link.ts` | Deep link URL 解析和处理 |
| `main/sources-service.ts` | Source 加载和认证服务 |
| `preload/index.ts` | Context bridge API |
| `renderer/App.tsx` | React 根组件、状态管理 |
| `renderer/contexts/NavigationContext.tsx` | 类型安全的路由和导航处理器 |
| `renderer/lib/navigate.ts` | 全局 `navigate()` 函数 |
| `renderer/hooks/useAgentState.ts` | Agent 激活状态机（基于 IPC） |
| `renderer/hooks/useBackgroundTasks.ts` | 后台任务跟踪 |
| `renderer/hooks/useStatuses.ts` | 工作区状态配置 |
| `renderer/hooks/useTheme.ts` | 级联主题解析 |
| `renderer/components/chat/Chat.tsx` | 带可调整面板的主聊天布局 |
| `renderer/components/chat/ChatInput.tsx` | 支持文件附件的消息输入框 |
| `renderer/components/chat/ChatDisplay.tsx` | 支持 Markdown 渲染的消息列表 |
| `renderer/components/app-shell/input/structured/PermissionRequest.tsx` | Bash 命令审批 UI |
| `renderer/components/chat/SessionList.tsx` | 支持重命名的会话侧边栏 |
| `renderer/components/chat/AttachmentPreview.tsx` | 文件附件气泡 |
| `renderer/components/ui/source-avatar.tsx` | 统一 source 图标组件 |
| `renderer/playground/` | 组件开发 playground |
| `shared/types.ts` | IPC channel、Message、Session、FileAttachment 类型 |
| `shared/routes.ts` | 类型安全的路由定义和构建器 |
| `shared/route-parser.ts` | 路由字符串解析工具 |
