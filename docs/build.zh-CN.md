# 打包说明书(速查版)

## 一键打包

```bash
# Apple Silicon (M1/M2/M3/M4)
bash apps/electron/scripts/build-dmg.sh arm64

# Intel Mac
bash apps/electron/scripts/build-dmg.sh x64

# Linux x64
bash apps/electron/scripts/build-linux.sh

# Windows x64(在 Windows / PowerShell 上)
pwsh apps/electron/scripts/build-win.ps1
```

签名/公证:设了 `APPLE_SIGNING_IDENTITY` + `APPLE_ID` + `APPLE_TEAM_ID` + `APPLE_APP_SPECIFIC_PASSWORD` 就自动启用;没设就走 ad-hoc 签名(可本地装,不能公开分发)。

## 产物位置

`apps/electron/release/`:

| 文件 | 用途 |
|---|---|
| `Craft-Agents-<arch>.dmg` | macOS 安装包 |
| `Craft-Agents-<arch>.zip` | electron-updater 增量更新源 |
| `latest-mac.yml` | 更新清单 |

## 关键坑

### 1. 不要用 `bun run electron:dist:dev:mac`

`package.json` 里那些 `electron:dist*` 命令**直接调 electron-builder**,跳过了打包前的 SDK 拷贝步骤。打出来的 .app 缺:

- `node_modules/@anthropic-ai/claude-agent-sdk-binary/claude`(SDK 原生二进制,~205 MB)
- `node_modules/@vscode/ripgrep`

后果:UI 能开,但 Anthropic / Claude Max 路径的会话起不来。

**用 `build-dmg.sh` 才是完整路径** — 它先把根 `node_modules/` 里 hoist 的依赖拷到 `apps/electron/node_modules/`,再跑 electron-builder。

### 2. 双架构 DMG bug

`build-dmg.sh arm64` 会**同时**产出 `Craft-Agents-arm64.dmg` 和 `Craft-Agents-x64.dmg`,但**两个里面装的都是 arm64 的 claude binary**(脚本只为命令行指定的架构拷贝,而 electron-builder.yml 强制打两个 target)。

要发布给 Intel Mac 用户,必须**单独再跑一次** `build-dmg.sh x64`,从那次的产物里取 `Craft-Agents-x64.dmg`。**不要直接用同一次跑出来的 x64 DMG**。

### 3. 验证产物完整性

打完后用这个 check:

```bash
APP="apps/electron/release/mac-arm64/Craft Agents.app"
file "$APP/Contents/Resources/app/node_modules/@anthropic-ai/claude-agent-sdk-binary/claude"
# 期望: Mach-O 64-bit executable arm64,大小 ~205 MB

ls "$APP/Contents/Resources/app/resources/"{session,pi}-mcp-server/index.js
# 期望: 两个 bundle 都在,session ~4.4 MB,pi ~26 MB
```

二进制小于 50 MB 就是没拷对(参考 [scripts/build/darwin.ts:26](../scripts/build/darwin.ts#L26) 的 `verifyPackagedSDK` 校验值)。

### 4. cross-arch 打包

在 arm64 机器上跑 `build-dmg.sh x64`(或反过来),根 `node_modules` 里不会有目标架构的 `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` 包。脚本会用 `npm pack` 临时拉一份(见 [build-dmg.sh:147-160](../apps/electron/scripts/build-dmg.sh#L147))。需要联网。

## 常见失败 → 修法

| 报错 | 原因 | 修法 |
|---|---|---|
| `SDK core not found at .../claude-agent-sdk` | `bun install` 没跑或被中断 | 根目录跑 `bun install` |
| `ripgrep binary` 找不到 | postinstall 没跑 | `bun pm trust @vscode/ripgrep` |
| `claude binary ... only X bytes` | 拷贝中断/磁盘满 | 清 `apps/electron/node_modules` 重跑 |
| `EBUSY`(Windows) | bun.exe 被锁 | electron-builder.yml 已 workaround,用 `build-win.ps1` 别直接调 electron-builder |
| `file source doesn't exist from=.../@anthropic-ai/...` | 走了 dev 路径,SDK 没预拷贝 | 改用 `build-dmg.sh` |

## 仅开发联调

不需要 DMG、只想本地跑:

```bash
bun run electron:dev          # 热重载
bun run electron:start        # 一次性 build + 启动
```

这俩**不**需要 SDK 拷贝步骤,因为 dev 模式下 SDK 直接从根 `node_modules/` 解析。
