/**
 * Phase-0 GO/NO-GO spike for WeChat (iLink) support in messaging-gateway.
 *
 * Validates that Tencent's official ClawBot iLink transport accepts a
 * craft-agent client (iLink-App-Id "bot", bot_agent "CraftAgent/x") — i.e. the
 * official transport is reusable outside OpenClaw. Flow:
 *   1. Fetch a login QR and render it in the terminal.
 *   2. Scan it with your personal WeChat (ClawBot plugin / in-app prompt).
 *   3. On confirm, long-poll getUpdates and ECHO each inbound text back.
 *
 * Run:  bun run packages/messaging-gateway/scripts/wechat-ilink-spike.ts
 * Stop: Ctrl-C.
 */
import os from "node:os"
import path from "node:path"

import { setStateDir } from "../src/adapters/wechat/ilink/storage/state-dir"
import {
  startWeixinLoginWithQr,
  waitForWeixinLogin,
  displayQRCode,
} from "../src/adapters/wechat/ilink/auth/login-qr"
import {
  saveWeixinAccount,
  registerWeixinAccountId,
} from "../src/adapters/wechat/ilink/auth/accounts"
import { monitorWeixinProvider } from "../src/adapters/wechat/ilink/monitor/monitor"
import { sendMessage } from "../src/adapters/wechat/ilink/api/api"
import { MessageItemType } from "../src/adapters/wechat/ilink/api/types"
import { weixinMessageToMsgContext } from "../src/adapters/wechat/ilink/messaging/inbound"

const ILINK_BASE = "https://ilinkai.weixin.qq.com"

async function main(): Promise<void> {
  // Keep spike state out of the default state dir.
  setStateDir(path.join(os.tmpdir(), "craft-wechat-spike"))

  console.log("[spike] requesting login QR from", ILINK_BASE)
  const start = await startWeixinLoginWithQr({ apiBaseUrl: ILINK_BASE })
  if (!start.qrcodeUrl) {
    console.error("[spike] NO-GO — failed to get QR:", start.message)
    process.exit(1)
  }
  console.log("\n[spike]", start.message, "\n")
  await displayQRCode(start.qrcodeUrl)

  console.log("\n[spike] waiting for scan + confirm (up to 8 min)...")
  const result = await waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: ILINK_BASE,
    verbose: true,
  })
  if (!result.connected || !result.accountId) {
    console.error("\n[spike] NO-GO — login not completed:", result.message)
    process.exit(1)
  }

  const accountId = result.accountId
  const token = result.botToken
  const baseUrl = result.baseUrl || ILINK_BASE
  console.log(
    `\n[spike] GO — connected. accountId=${accountId} baseUrl=${baseUrl} userId=${result.userId ?? "?"}`,
  )
  saveWeixinAccount(accountId, { token, baseUrl, userId: result.userId })
  registerWeixinAccountId(accountId)

  const abort = new AbortController()
  process.on("SIGINT", () => {
    console.log("\n[spike] stopping...")
    abort.abort()
    setTimeout(() => process.exit(0), 200)
  })

  console.log("[spike] listening — send your WeChat bot a text; it will be echoed back.\n")
  await monitorWeixinProvider({
    baseUrl,
    token,
    accountId,
    abortSignal: abort.signal,
    onPoll: () => process.stdout.write("."),
    onMessage: async (msg) => {
      const ctx = weixinMessageToMsgContext(msg, accountId)
      const from = msg.from_user_id ?? ""
      console.log(`\n[spike] inbound from=${from}: ${JSON.stringify(ctx.Body)}`)
      if (!from || !ctx.Body) return
      await sendMessage({
        baseUrl,
        token,
        body: {
          msg: {
            to_user_id: from,
            context_token: msg.context_token,
            item_list: [
              { type: MessageItemType.TEXT, text_item: { text: `echo: ${ctx.Body}` } },
            ],
          },
        },
      })
      console.log(`[spike] echoed back to ${from}`)
    },
  })
}

main().catch((err) => {
  console.error("[spike] fatal:", err)
  process.exit(1)
})
