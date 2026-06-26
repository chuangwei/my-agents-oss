/**
 * LarkAdapter — Lark / Feishu in-process adapter.
 *
 * Transport: long-polling via `@larksuiteoapi/node-sdk`'s `WSClient`. No public
 * webhook URL needed (correct fit for desktop / electron). Same lifecycle
 * shape as the Telegram adapter, just a different SDK underneath.
 *
 * Phase 1 scope (text only): receive text in DMs and group @mentions, send
 * text replies, support `/pair`-style commands. Phase 2 layers on edits,
 * interactive cards, attachments, and Markdown→post rich-text formatting.
 */

import { writeFileSync, statSync, unlinkSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import * as lark from '@larksuiteoapi/node-sdk'
import type {
  PlatformAdapter,
  PlatformConfig,
  AdapterCapabilities,
  IncomingAttachment,
  IncomingMessage,
  SentMessage,
  InlineButton,
  ButtonPress,
  MessagingLogger,
  SendOptions,
} from '../../types'
import {
  formatForLarkPost,
  wrapAsTrivialPost,
  type LarkPost,
} from './format'
import {
  buildLarkCard,
  buildClearedCard,
  isLarkEditExpiredError,
  LARK_MAX_BUTTONS,
} from './card'
import { SeenMessageStore } from '../../seen-message-store'

/**
 * Hard cap for downloaded attachment size. Matches `MAX_FILE_SIZE` in
 * `@craft-agent/shared/utils/files` — files larger than this would be rejected
 * by `readFileAttachment` anyway, so we fail fast in the adapter with a
 * user-visible reply instead of letting the reader throw downstream.
 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/**
 * Message types we can't process yet but that are clearly user content — we
 * reply with a hint instead of silently dropping. System/event-ish types stay
 * silent to avoid noise.
 */
const UNSUPPORTED_NOTICE_TYPES = new Set(['audio', 'media', 'sticker'])

const UNSUPPORTED_NOTICE_TEXT: Record<string, string> = {
  audio: '我暂时还听不了语音消息,麻烦发文字或截图给我~',
  media: '我暂时还看不了视频消息,麻烦发文字或截图给我~',
  sticker: '我暂时还看不懂表情包,有事可以直接发文字给我~',
}

const UNSUPPORTED_NOTICE_DEFAULT = '我暂时还处理不了这种消息,麻烦发文字或截图给我~'

/** Reply sent when an attachment is too large to download. */
const ATTACHMENT_TOO_LARGE_NOTICE = `文件太大了(超过 ${Math.round(
  MAX_ATTACHMENT_BYTES / (1024 * 1024),
)}MB),我这边收不下,麻烦压缩后再发,或者直接发文字/截图~`

/** Outcome of a resource download, so callers can give specific user feedback. */
type DownloadResult =
  | { ok: true; localPath: string }
  | { ok: false; reason: 'too_large' | 'error' }

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

/**
 * Credential payload for a Lark/Feishu bot.
 *
 * Stored as a JSON string in the `messaging_bearer` credential row (one row
 * per workspace+platform). Single existing schema, no migrations.
 */
export interface LarkCredentials {
  appId: string
  appSecret: string
  /**
   * Which Open Platform domain to talk to. Lark and Feishu are separate
   * ecosystems — a Lark bot only works against open.larksuite.com,
   * a Feishu bot only against open.feishu.cn.
   */
  domain: 'lark' | 'feishu'
}

/**
 * Parse the JSON-encoded credentials from `PlatformConfig.token`.
 *
 * Throws with a clear message if the input is malformed — surfaces as
 * `state: 'error'` with a user-readable `lastError` in the registry.
 */
export function parseLarkCredentials(token: string | undefined): LarkCredentials {
  if (!token) throw new Error('Lark credentials are missing')
  let parsed: unknown
  try {
    parsed = JSON.parse(token)
  } catch {
    throw new Error('Lark credentials are not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Lark credentials must be a JSON object')
  }
  const { appId, appSecret, domain } = parsed as Record<string, unknown>
  if (typeof appId !== 'string' || appId.length === 0) {
    throw new Error('Lark credentials are missing `appId`')
  }
  if (typeof appSecret !== 'string' || appSecret.length === 0) {
    throw new Error('Lark credentials are missing `appSecret`')
  }
  if (domain !== 'lark' && domain !== 'feishu') {
    throw new Error('Lark credentials `domain` must be "lark" or "feishu"')
  }
  return { appId, appSecret, domain }
}

/**
 * Map our `'lark' | 'feishu'` selector to the SDK's `Domain` enum.
 */
function resolveLarkDomain(domain: 'lark' | 'feishu'): lark.Domain {
  return domain === 'feishu' ? lark.Domain.Feishu : lark.Domain.Lark
}

function extractLarkMessageId(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const root = result as Record<string, unknown>
  const data = root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : undefined
  const nestedData =
    data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : undefined

  const candidates = [
    root.message_id,
    root.messageId,
    data?.message_id,
    data?.messageId,
    nestedData?.message_id,
    nestedData?.messageId,
  ]
  const id = candidates.find((value): value is string => typeof value === 'string' && value.length > 0)
  return id ?? ''
}

function extractLarkReactionId(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const root = result as Record<string, unknown>
  const data = root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : undefined
  const nestedData =
    data?.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : undefined

  const candidates = [
    root.reaction_id,
    root.reactionId,
    data?.reaction_id,
    data?.reactionId,
    nestedData?.reaction_id,
    nestedData?.reactionId,
  ]
  const id = candidates.find((value): value is string => typeof value === 'string' && value.length > 0)
  return id ?? ''
}

/**
 * Strip a leading `<at user_id="...">…</at> ` prefix from a Lark text message
 * content. Lark prepends the @mention as a literal in the content, but the
 * agent only cares about what comes after.
 */
function stripMentionPrefix(text: string): string {
  return text.replace(/^<at[^>]*>[^<]*<\/at>\s*/, '').trim()
}

function stripMarkdownForLarkText(text: string): string {
  return text
    .replace(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n```/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
}

/**
 * A single inline node inside a Lark `post` (rich-text) message. Lark nests
 * paragraphs as `content: Node[][]` — an array of lines, each an array of
 * inline runs. We only consume the handful of tags that carry user intent.
 */
interface LarkPostNode {
  tag?: string
  text?: string
  href?: string
  image_key?: string
  user_name?: string
}

/**
 * Flatten a Lark `post` message's JSON content into plain text + the
 * `image_key`s of any embedded screenshots/images.
 *
 * This is the inbound counterpart to `formatForLarkPost` (outbound). It exists
 * because Feishu sends "screenshot + caption" (and any image-with-text) as a
 * `post` message — NOT as `image`/`text` — so without this the whole message
 * was being dropped as an unsupported type.
 *
 * Tag handling:
 *  - `text` → kept verbatim
 *  - `a`    → rendered as `label (href)` so the URL survives for the agent
 *  - `img`  → `image_key` collected for download (text drops the node)
 *  - `at`   → dropped (mirrors `stripMentionPrefix` for text messages — the
 *             agent doesn't need the @bot mention noise)
 *  - other  → ignored (emotion stickers, etc.)
 */
export function parseLarkPostContent(rawContent: string): { text: string; imageKeys: string[] } {
  let parsed: { title?: unknown; content?: unknown }
  try {
    parsed = JSON.parse(rawContent)
  } catch {
    return { text: '', imageKeys: [] }
  }

  const imageKeys: string[] = []
  const lines: string[] = []
  const rows = Array.isArray(parsed.content) ? (parsed.content as unknown[]) : []

  for (const row of rows) {
    const parts: string[] = []
    for (const rawNode of Array.isArray(row) ? (row as unknown[]) : []) {
      const node = (rawNode ?? {}) as LarkPostNode
      switch (node.tag) {
        case 'text':
          if (typeof node.text === 'string') parts.push(node.text)
          break
        case 'a': {
          const label = typeof node.text === 'string' ? node.text : ''
          const href = typeof node.href === 'string' ? node.href : ''
          if (label && href) parts.push(`${label} (${href})`)
          else if (href) parts.push(href)
          else if (label) parts.push(label)
          break
        }
        case 'img':
          if (typeof node.image_key === 'string' && node.image_key) imageKeys.push(node.image_key)
          break
        // `at` and any unknown tag are intentionally dropped.
      }
    }
    lines.push(parts.join(''))
  }

  let text = lines.join('\n').trim()
  const title = typeof parsed.title === 'string' ? parsed.title.trim() : ''
  if (title) text = text ? `${title}\n${text}` : title
  return { text, imageKeys }
}

/**
 * Narrow projection over the SDK's `Client` for the methods we actually call.
 * The SDK's full type union is enormous (~250k lines) and changes shape between
 * minor versions; pinning a hand-rolled interface keeps our adapter loosely
 * coupled and the ts-checker happy.
 */
interface LarkClient {
  im: {
    message: {
      create: (args: {
        params: { receive_id_type: 'chat_id' | 'open_id' | 'union_id' }
        data: { receive_id: string; msg_type: string; content: string; uuid?: string }
      }) => Promise<unknown>
      update: (args: {
        path: { message_id: string }
        data: { msg_type: string; content: string }
      }) => Promise<unknown>
      patch: (args: {
        path: { message_id: string }
        data: { content: string }
      }) => Promise<unknown>
    }
    messageReaction: {
      create: (args: {
        path: { message_id: string }
        data: { reaction_type: { emoji_type: string } }
      }) => Promise<unknown>
      delete: (args: {
        path: { message_id: string; reaction_id: string }
      }) => Promise<unknown>
    }
    file: {
      create: (args: {
        data: { file_type: string; file_name: string; file: Buffer }
      }) => Promise<{ file_key?: string } | null>
    }
    image: {
      create: (args: {
        data: { image_type: 'message' | 'avatar'; image: Buffer }
      }) => Promise<{ image_key?: string } | null>
    }
  }
}

/**
 * Flat shape after the SDK's `EventDispatcher.parse()` unwraps the v2 envelope.
 * The dispatcher merges `{schema, header, event}` into a single object before
 * invoking handlers, so payload fields land at the top level — there is no
 * outer `.event` accessor.
 */
interface LarkMessageEvent {
  sender: {
    sender_id?: { user_id?: string; open_id?: string; union_id?: string }
  }
  message: {
    message_id: string
    chat_id: string
    chat_type: string
    message_type: string
    content: string
    create_time: string
    mentions?: Array<{ key: string; id: { user_id?: string }; name: string }>
  }
}

/**
 * Card-action press event after the SDK's `EventDispatcher.parse()` flattens
 * the v2 envelope. Schema 2.0 nests the chat id under `context` instead of
 * at the top level — handle both shapes so the same code path works for v1
 * and v2 cards.
 */
interface LarkCardActionEvent {
  operator?: { user_id?: string; open_id?: string; union_id?: string }
  /** Schema 1.0 location for the chat id. */
  open_chat_id?: string
  /** Schema 2.0 location — `context.open_chat_id` and friends. */
  context?: {
    open_chat_id?: string
    open_message_id?: string
  }
  action?: {
    value?: unknown
    tag?: string
  }
}

export class LarkAdapter implements PlatformAdapter {
  readonly platform = 'lark' as const
  readonly capabilities: AdapterCapabilities = {
    messageEditing: true,
    inlineButtons: true,
    maxButtons: LARK_MAX_BUTTONS,
    maxMessageLength: 30000,
    markdown: 'lark-post',
    webhookSupport: false,
  }

  private client: LarkClient | null = null
  private wsClient: lark.WSClient | null = null
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null
  private buttonHandler: ((press: ButtonPress) => Promise<void>) | null = null
  private connected = false
  private log: MessagingLogger = NOOP_LOGGER
  private readonly seenStore: SeenMessageStore
  /**
   * Track each outbound message's wire `msg_type` so `editMessage` can dispatch
   * to `update` (text/post) vs `patch` (interactive card) correctly. Lark
   * requires the new `msg_type` to match the original.
   */
  private sentMsgTypes = new Map<string, 'text' | 'post' | 'interactive'>()
  private receivedReactionIds = new Map<string, string>()

  constructor(seenStore?: SeenMessageStore) {
    // storageDir omitted → in-memory only: keeps no-arg construction working
    // for tests and as a safe fallback when no messaging dir is available.
    this.seenStore = seenStore ?? new SeenMessageStore()
  }

  async markMessageReceived(msg: IncomingMessage): Promise<void> {
    if (!this.client || !msg.messageId) return
    try {
      const result = await this.client.im.messageReaction.create({
        path: { message_id: msg.messageId },
        data: { reaction_type: { emoji_type: 'Get' } },
      })
      const reactionId = extractLarkReactionId(result)
      if (reactionId) this.receivedReactionIds.set(msg.messageId, reactionId)
      this.log.info('[lark] marked inbound message as received', {
        event: 'lark_message_get_reaction_ok',
        chatId: msg.channelId,
        messageId: msg.messageId,
        reactionId,
      })
    } catch (err: unknown) {
      this.log.warn('[lark] failed to add GET reaction', {
        event: 'lark_message_get_reaction_failed',
        chatId: msg.channelId,
        messageId: msg.messageId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async clearMessageReceived(msg: IncomingMessage): Promise<void> {
    if (!this.client || !msg.messageId) return
    const reactionId = this.receivedReactionIds.get(msg.messageId)
    if (!reactionId) return
    try {
      await this.client.im.messageReaction.delete({
        path: { message_id: msg.messageId, reaction_id: reactionId },
      })
      this.receivedReactionIds.delete(msg.messageId)
      this.log.info('[lark] cleared inbound message received reaction', {
        event: 'lark_message_get_reaction_cleared',
        chatId: msg.channelId,
        messageId: msg.messageId,
        reactionId,
      })
    } catch (err: unknown) {
      this.log.warn('[lark] failed to clear GET reaction', {
        event: 'lark_message_get_reaction_clear_failed',
        chatId: msg.channelId,
        messageId: msg.messageId,
        reactionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Fetch bot profile for UI hints. */
  async getBotInfo(): Promise<{ name?: string } | null> {
    if (!this.client) return null
    try {
      // The SDK's `bot.v3.info.get` (no args) returns `{ data: { bot: { app_name } } }`.
      // Unsafe-cast through unknown — the bot namespace isn't in our narrow projection.
      const c = this.client as unknown as {
        bot: { v3: { info: { get: () => Promise<{ data?: { bot?: { app_name?: string } } }> } } }
      }
      const result = await c.bot.v3.info.get()
      const name = result.data?.bot?.app_name
      return name ? { name } : null
    } catch {
      return null
    }
  }

  async initialize(config: PlatformConfig): Promise<void> {
    this.log = config.logger ?? NOOP_LOGGER
    const creds = parseLarkCredentials(config.token)
    const sdkDomain = resolveLarkDomain(creds.domain)

    // Construct REST client (sends + lookups go through this).
    this.client = new lark.Client({
      appId: creds.appId,
      appSecret: creds.appSecret,
      domain: sdkDomain,
      loggerLevel: lark.LoggerLevel.warn,
    }) as unknown as LarkClient

    // Long-connection WS client + event dispatcher.
    //
    // Lifecycle hooks log explicitly so we can distinguish "socket never
    // opened" from "socket open but no events firing" — the second one
    // usually means the app's scopes or event subscriptions are misconfigured
    // on the Open Platform side, which is invisible from our side otherwise.
    this.wsClient = new lark.WSClient({
      appId: creds.appId,
      appSecret: creds.appSecret,
      domain: sdkDomain,
      loggerLevel: lark.LoggerLevel.info,
      onReady: () => {
        this.log.info('[lark] ws ready', { event: 'lark_ws_ready' })
      },
      onError: (err: unknown) => {
        this.log.error('[lark] ws error', {
          event: 'lark_ws_error',
          error: err instanceof Error ? err.message : String(err),
        })
      },
      onReconnecting: () => {
        this.log.info('[lark] ws reconnecting', { event: 'lark_ws_reconnecting' })
      },
      onReconnected: () => {
        this.log.info('[lark] ws reconnected', { event: 'lark_ws_reconnected' })
      },
    } as unknown as ConstructorParameters<typeof lark.WSClient>[0])

    // The SDK's `register` typing is a wide-open union over hundreds of event
    // names. Cast the handler block once via `unknown` to keep the adapter
    // readable; the per-handler payload casts above handle the actual shape.
    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        await this.handleIncomingMessage(data as LarkMessageEvent)
      },
      'card.action.trigger': async (data: unknown) => {
        await this.handleCardAction(data as LarkCardActionEvent)
        // Lark expects a synchronous return that may patch the card; we
        // return an empty object (no patch) and let `clearButtons` do the
        // visual cleanup async via the binding's existing post-press flow.
        return {}
      },
    } as unknown as Parameters<lark.EventDispatcher['register']>[0])

    await this.wsClient.start({ eventDispatcher })
    this.connected = true
    this.log.info('[lark] connected', {
      event: 'lark_connected',
      domain: creds.domain,
    })
  }

  async destroy(): Promise<void> {
    const wsClient = this.wsClient as
      | {
          close?: (opts?: { force?: boolean }) => void | Promise<void>
        }
      | null
    if (wsClient?.close) {
      await wsClient.close({ force: true })
    }
    this.wsClient = null
    this.client = null
    this.connected = false
    this.sentMsgTypes.clear()
    this.seenStore.flush()
    this.receivedReactionIds.clear()
  }

  isConnected(): boolean {
    return this.connected
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  onButtonPress(handler: (press: ButtonPress) => Promise<void>): void {
    this.buttonHandler = handler
  }

  // -------------------------------------------------------------------------
  // Outbound — sends, edits, files, cards
  // -------------------------------------------------------------------------

  async sendText(channelId: string, text: string, _opts?: SendOptions): Promise<SentMessage> {
    if (!this.client) throw new Error('Lark adapter is not connected')
    const formatted = formatForLarkPost(text)
    const { msgType, content } =
      formatted.kind === 'text'
        ? { msgType: 'text' as const, content: JSON.stringify({ text: formatted.text }) }
        : { msgType: 'post' as const, content: JSON.stringify(formatted.post) }

    let result: unknown
    let finalMsgType = msgType
    try {
      result = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: channelId, msg_type: msgType, content },
      })
    } catch (err: unknown) {
      if (msgType !== 'post') throw err
      finalMsgType = 'text'
      const fallbackText = stripMarkdownForLarkText(text)
      // Surface Feishu's structured error (code/msg) so a future formatting
      // regression is diagnosable — but never log the message body itself.
      const larkErr = err as { response?: { data?: { code?: number; msg?: string } }; code?: number; msg?: string }
      const larkData = larkErr.response?.data
      this.log.warn('[lark] post send failed; falling back to text', {
        event: 'lark_post_send_fallback',
        chatId: channelId,
        error: err instanceof Error ? err.message : String(err),
        larkCode: larkData?.code ?? larkErr.code,
        larkMsg: larkData?.msg ?? larkErr.msg,
      })
      result = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: channelId,
          msg_type: 'text',
          content: JSON.stringify({ text: fallbackText }),
        },
      })
    }
    const messageId = extractLarkMessageId(result)
    if (!messageId) {
      this.log.warn('[lark] sendText returned no message id', {
        event: 'lark_send_text_no_message_id',
        chatId: channelId,
        msgType: finalMsgType,
      })
    }
    if (messageId) this.sentMsgTypes.set(messageId, finalMsgType)
    return { platform: 'lark', channelId, messageId }
  }

  async editMessage(
    channelId: string,
    messageId: string,
    text: string,
    _opts?: SendOptions,
  ): Promise<void> {
    if (!this.client) throw new Error('Lark adapter is not connected')
    const originalType = this.sentMsgTypes.get(messageId) ?? 'text'

    // Cards are patched, not updated — different API.
    if (originalType === 'interactive') {
      // Editing an active card replaces its text body but keeps the buttons.
      // For the text-only edit path the renderer takes, we fall back to a
      // cleared-card patch (text without buttons), matching the Telegram
      // behaviour where a final-text edit removes the button row.
      try {
        await this.client.im.message.patch({
          path: { message_id: messageId },
          data: { content: JSON.stringify(buildClearedCard(text)) },
        })
      } catch (err: unknown) {
        if (isLarkEditExpiredError(err)) {
          this.log.warn('[lark] card edit expired or unavailable', {
            event: 'lark_card_edit_expired',
            chatId: channelId,
            messageId,
            error: err instanceof Error ? err.message : String(err),
          })
          return
        }
        this.log.warn('[lark] card edit failed', {
          event: 'lark_card_edit_failed',
          chatId: channelId,
          messageId,
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
      return
    }

    // text or post — match the original type so Lark accepts the update.
    let content: string
    let msgType: 'text' | 'post'
    if (originalType === 'post') {
      // If the new content has formatting, format it; otherwise wrap as
      // a trivial post so the msg_type still matches the original.
      const formatted = formatForLarkPost(text)
      const post: LarkPost = formatted.kind === 'post' ? formatted.post : wrapAsTrivialPost(text)
      content = JSON.stringify(post)
      msgType = 'post'
    } else {
      content = JSON.stringify({ text })
      msgType = 'text'
    }

    try {
      await this.client.im.message.update({
        path: { message_id: messageId },
        data: { msg_type: msgType, content },
      })
    } catch (err: unknown) {
      if (isLarkEditExpiredError(err)) {
        this.log.warn('[lark] message edit expired or unavailable', {
          event: 'lark_message_edit_expired',
          chatId: channelId,
          messageId,
          msgType,
          error: err instanceof Error ? err.message : String(err),
        })
        return
      }
      this.log.warn('[lark] message edit failed', {
        event: 'lark_message_edit_failed',
        chatId: channelId,
        messageId,
        msgType,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  async sendButtons(
    channelId: string,
    text: string,
    buttons: InlineButton[],
    _opts?: SendOptions,
  ): Promise<SentMessage> {
    if (!this.client) throw new Error('Lark adapter is not connected')
    if (buttons.length > LARK_MAX_BUTTONS) {
      this.log.warn('[lark] too many buttons; truncating to cap', {
        event: 'lark_button_cap',
        requested: buttons.length,
        cap: LARK_MAX_BUTTONS,
      })
    }

    // Send the card without the messageId in the buttons' value — we don't
    // know the messageId until after the create. Fix this up in two stages:
    // 1) post the card with a placeholder; 2) extract the returned message_id
    //    and patch the card with the real value. Phase 2 acceptance is good
    //    enough — the press handler can look up the binding from chat_id alone
    //    if needed, but storing the id keeps gated routing simple.
    const placeholderCard = buildLarkCard(text, buttons, { messageId: 'pending' })
    const cardJson = JSON.stringify(placeholderCard)

    // Wrap the API call so any payload-shape / scope / quota issues surface
    // in our logs with a structured `lark_send_card_failed` event instead of
    // bubbling up unannotated through the renderer's outer catch. We also
    // post a plain-text fallback so the user always sees *something* in the
    // chat when the rich card path breaks, then re-throw so the renderer
    // can record the failure.
    let messageId = ''
    try {
      const result = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: channelId,
          msg_type: 'interactive',
          content: cardJson,
        },
      })
      messageId = extractLarkMessageId(result)
      this.log.info('[lark] sent card', {
        event: 'lark_send_card_ok',
        chatId: channelId,
        messageId,
        buttonCount: Math.min(buttons.length, LARK_MAX_BUTTONS),
      })
    } catch (err: unknown) {
      // The SDK wraps every error in axios's `AxiosError`. The actual
      // Lark-side reason (code + msg) lives at `err.response.data`, NOT at
      // the top level — extract it so the log line is actually useful.
      const errObj = (err ?? {}) as {
        code?: unknown
        msg?: unknown
        message?: unknown
        response?: { status?: unknown; data?: unknown }
      }
      const responseData = (errObj.response?.data ?? null) as
        | { code?: unknown; msg?: unknown; error?: unknown }
        | null
      this.log.error('[lark] failed to send card', {
        event: 'lark_send_card_failed',
        chatId: channelId,
        httpStatus: typeof errObj.response?.status === 'number' ? errObj.response.status : undefined,
        larkCode:
          typeof responseData?.code === 'number'
            ? responseData.code
            : typeof errObj.code === 'number'
              ? errObj.code
              : undefined,
        larkMsg:
          typeof responseData?.msg === 'string'
            ? responseData.msg
            : typeof errObj.msg === 'string'
              ? errObj.msg
              : undefined,
        larkError: responseData?.error,
        error: err instanceof Error ? err.message : String(err),
        payloadSize: cardJson.length,
        payloadPreview: cardJson.slice(0, 500),
        buttonCount: buttons.length,
      })
      // Best-effort plain-text fallback so the user knows something happened.
      // Failures here are non-fatal — we still re-throw the original card error.
      try {
        await this.sendText(
          channelId,
          `${text}\n\n(Open the desktop app to respond — the in-chat buttons couldn't be sent.)`,
          _opts,
        )
      } catch {
        // Swallowed — the renderer's outer handler will see the original throw.
      }
      throw err
    }

    if (messageId) {
      this.sentMsgTypes.set(messageId, 'interactive')
      // Patch with the real message_id baked into each button's value so card
      // press events carry the correct correlation.
      try {
        const realCard = buildLarkCard(text, buttons, { messageId })
        await this.client.im.message.patch({
          path: { message_id: messageId },
          data: { content: JSON.stringify(realCard) },
        })
      } catch (err: unknown) {
        // Non-fatal — the card already exists with placeholder ids; press
        // routing will fall back to looking up by chat_id.
        if (!isLarkEditExpiredError(err)) {
          this.log.warn('[lark] failed to patch card with real messageId', {
            event: 'lark_card_patch_failed',
            messageId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
    return { platform: 'lark', channelId, messageId }
  }

  async clearButtons(channelId: string, messageId: string, _opts?: SendOptions): Promise<void> {
    if (!this.client) return
    void channelId
    try {
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(buildClearedCard('')) },
      })
    } catch (err: unknown) {
      if (isLarkEditExpiredError(err)) return
      this.log.warn('[lark] clearButtons failed', {
        event: 'lark_clear_buttons_failed',
        messageId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async sendTyping(_channelId: string, _opts?: SendOptions): Promise<void> {
    // Lark has no typing-indicator API. No-op.
  }

  async sendFile(
    channelId: string,
    file: Buffer,
    filename: string,
    caption?: string,
    _opts?: SendOptions,
  ): Promise<SentMessage> {
    if (!this.client) throw new Error('Lark adapter is not connected')

    const isImage = /\.(jpe?g|png|gif|webp|bmp)$/i.test(filename)

    let content: string
    let msgType: 'image' | 'file'
    if (isImage) {
      const upload = await this.client.im.image.create({
        data: { image_type: 'message', image: file },
      })
      const imageKey = upload?.image_key
      if (!imageKey) throw new Error('Lark image upload returned no image_key')
      content = JSON.stringify({ image_key: imageKey })
      msgType = 'image'
    } else {
      const upload = await this.client.im.file.create({
        data: { file_type: 'stream', file_name: filename, file: file },
      })
      const fileKey = upload?.file_key
      if (!fileKey) throw new Error('Lark file upload returned no file_key')
      content = JSON.stringify({ file_key: fileKey, file_name: filename })
      msgType = 'file'
    }

    const result = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: channelId, msg_type: msgType, content },
    })
    const messageId = extractLarkMessageId(result)

    // Lark can't combine caption + file in one message. If the caller wants a
    // caption, send it as a follow-up text message (best-effort).
    if (caption) {
      this.sendText(channelId, caption).catch((err) => {
        this.log.warn('[lark] caption follow-up failed', {
          event: 'lark_caption_failed',
          messageId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }

    return { platform: 'lark', channelId, messageId }
  }

  // -------------------------------------------------------------------------
  // Inbound — message + card events
  // -------------------------------------------------------------------------

  private async handleIncomingMessage(data: LarkMessageEvent): Promise<void> {
    if (!this.messageHandler) return
    const { sender, message } = data

    // Visibility log: if this never fires, the bot isn't getting the event
    // from Lark. Most common causes: missing `im:message` scope, missing
    // event subscription, or app not published.
    this.log.info('[lark] event received', {
      event: 'lark_event_received',
      messageType: message.message_type,
      chatType: message.chat_type,
      chatId: message.chat_id,
      messageId: message.message_id,
    })

    if (this.seenStore.has(message.message_id)) {
      this.log.info('[lark] dropped duplicate event', {
        event: 'lark_duplicate_event',
        chatId: message.chat_id,
        messageId: message.message_id,
      })
      return
    }
    this.seenStore.add(message.message_id)

    const senderId =
      sender.sender_id?.user_id ?? sender.sender_id?.open_id ?? sender.sender_id?.union_id ?? ''

    // Phase 2: support text + image + file. Other types (audio/video/sticker/etc.)
    // are dropped with an info log so users can see the bot received the event
    // but can't process it.
    if (message.message_type === 'text') {
      let text: string
      try {
        const parsed = JSON.parse(message.content) as { text?: string }
        text = parsed.text ?? ''
      } catch {
        text = ''
      }
      const cleaned = stripMentionPrefix(text)
      const msg: IncomingMessage = {
        platform: 'lark',
        channelId: message.chat_id,
        messageId: message.message_id,
        senderId,
        text: cleaned,
        timestamp: parseInt(message.create_time, 10) || Date.now(),
        raw: message,
      }
      this.dispatchIncomingMessage(msg)
      return
    }

    if (message.message_type === 'image' || message.message_type === 'file') {
      await this.handleAttachmentMessage(data)
      return
    }

    // `post` = rich text (text + inline images). Feishu sends "screenshot +
    // caption" and any image-with-text this way, so it must be parsed rather
    // than dropped.
    if (message.message_type === 'post') {
      await this.handlePostMessage(data)
      return
    }

    // Stickers carry a `file_key` to a small image. Try to download it as an
    // image so the agent's vision can actually "see" it; only fall through to
    // the unsupported-type notice if the download fails.
    if (message.message_type === 'sticker') {
      const handled = await this.handleStickerMessage(data)
      if (handled) return
    }

    // Unhandled type — log and drop. For user-sent media (voice/video/sticker)
    // we also reply once so the user isn't left with "seen, no answer".
    this.log.info('[lark] dropped unsupported message type', {
      event: 'lark_unsupported_msg_type',
      messageType: message.message_type,
      messageId: message.message_id,
      chatId: message.chat_id,
    })

    if (UNSUPPORTED_NOTICE_TYPES.has(message.message_type) && message.chat_type === 'p2p') {
      const notice = UNSUPPORTED_NOTICE_TEXT[message.message_type] ?? UNSUPPORTED_NOTICE_DEFAULT
      this.sendText(message.chat_id, notice).catch((err: unknown) => {
        this.log.warn('[lark] failed to send unsupported-type notice', {
          event: 'lark_unsupported_notice_failed',
          chatId: message.chat_id,
          messageType: message.message_type,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
  }

  private async handleAttachmentMessage(data: LarkMessageEvent): Promise<void> {
    if (!this.client || !this.messageHandler) return
    const { sender, message } = data
    const senderId =
      sender.sender_id?.user_id ?? sender.sender_id?.open_id ?? sender.sender_id?.union_id ?? ''

    let parsedContent: { image_key?: string; file_key?: string; file_name?: string }
    try {
      parsedContent = JSON.parse(message.content)
    } catch {
      this.log.warn('[lark] could not parse attachment content', {
        event: 'lark_attachment_parse_failed',
        messageId: message.message_id,
      })
      return
    }

    const isImage = message.message_type === 'image'
    const fileKey = isImage ? parsedContent.image_key : parsedContent.file_key
    if (!fileKey) {
      this.log.warn('[lark] attachment missing key', {
        event: 'lark_attachment_no_key',
        messageId: message.message_id,
      })
      return
    }
    const fallbackName = isImage
      ? `image-${randomBytes(4).toString('hex')}.jpg`
      : parsedContent.file_name ?? `file-${randomBytes(4).toString('hex')}.bin`

    const download = await this.downloadResource({
      messageId: message.message_id,
      fileKey,
      filename: fallbackName,
      isImage,
    })
    if (!download.ok) {
      if (download.reason === 'too_large' && message.chat_type === 'p2p') {
        this.sendText(message.chat_id, ATTACHMENT_TOO_LARGE_NOTICE).catch(() => {})
      }
      return
    }

    const incomingAttachment: IncomingAttachment = {
      type: isImage ? 'photo' : 'document',
      fileId: fileKey,
      fileName: fallbackName,
      localPath: download.localPath,
    }
    const msg: IncomingMessage = {
      platform: 'lark',
      channelId: message.chat_id,
      messageId: message.message_id,
      senderId,
      text: '',
      attachments: [incomingAttachment],
      timestamp: parseInt(message.create_time, 10) || Date.now(),
      raw: message,
    }
    this.dispatchIncomingMessage(msg)
  }

  /**
   * Handle a `sticker` message by downloading its image so the agent's vision
   * can see it (rather than just replying "I can't read stickers"). Feishu
   * sticker content is `{"file_key":"..."}`.
   *
   * Returns `true` when the sticker was downloaded and dispatched; `false` when
   * it couldn't be handled (no key / download failed), so the caller falls back
   * to the unsupported-type notice. This keeps a hard "no regression" guarantee.
   */
  private async handleStickerMessage(data: LarkMessageEvent): Promise<boolean> {
    if (!this.client || !this.messageHandler) return false
    const { sender, message } = data
    const senderId =
      sender.sender_id?.user_id ?? sender.sender_id?.open_id ?? sender.sender_id?.union_id ?? ''

    let fileKey: string | undefined
    try {
      fileKey = (JSON.parse(message.content) as { file_key?: string }).file_key
    } catch {
      fileKey = undefined
    }
    if (!fileKey) {
      this.log.warn('[lark] sticker missing file_key', {
        event: 'lark_sticker_no_key',
        messageId: message.message_id,
      })
      return false
    }

    const download = await this.downloadResource({
      messageId: message.message_id,
      fileKey,
      filename: `sticker-${randomBytes(4).toString('hex')}.webp`,
      isImage: true,
    })
    if (!download.ok) {
      // Couldn't fetch the sticker image — let the caller send the notice.
      return false
    }

    // Feishu stickers can be webp/png/gif; the downstream reader keys off the
    // file extension to set the media type, so a wrong extension would make the
    // model API reject the image on a mime/data mismatch. Sniff the real format.
    const localPath = this.fixImageExtension(download.localPath)

    const msg: IncomingMessage = {
      platform: 'lark',
      channelId: message.chat_id,
      messageId: message.message_id,
      senderId,
      text: '',
      attachments: [
        {
          type: 'photo',
          fileId: fileKey,
          fileName: `sticker${extname(localPath)}`,
          localPath,
        },
      ],
      timestamp: parseInt(message.create_time, 10) || Date.now(),
      raw: message,
    }
    this.dispatchIncomingMessage(msg)
    return true
  }

  /**
   * Rename a downloaded image temp file to match its actual format (sniffed from
   * magic bytes), since the downstream reader infers the media type from the
   * extension. Returns the (possibly new) path; falls back to the original path
   * on any error.
   */
  private fixImageExtension(localPath: string): string {
    try {
      const head = readFileSync(localPath).subarray(0, 12)
      let ext = ''
      if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) ext = '.png'
      else if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) ext = '.jpg'
      else if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) ext = '.gif'
      else if (
        head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
        head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
      ) ext = '.webp'

      if (!ext || extname(localPath).toLowerCase() === ext) return localPath

      const current = extname(localPath)
      const renamed = `${localPath.slice(0, localPath.length - current.length)}${ext}`
      renameSync(localPath, renamed)
      return renamed
    } catch {
      return localPath
    }
  }

  /**
   * Handle a `post` (rich-text) message: extract the plain text and download
   * every embedded image, then dispatch one `IncomingMessage` carrying both.
   * This is what makes "screenshot + caption" (and any image-with-text) work,
   * since Feishu delivers those as `post`, not `image`/`text`.
   */
  private async handlePostMessage(data: LarkMessageEvent): Promise<void> {
    if (!this.client || !this.messageHandler) return
    const { sender, message } = data
    const senderId =
      sender.sender_id?.user_id ?? sender.sender_id?.open_id ?? sender.sender_id?.union_id ?? ''

    const { text, imageKeys } = parseLarkPostContent(message.content)

    const attachments: IncomingAttachment[] = []
    let anyTooLarge = false
    for (const imageKey of imageKeys) {
      const download = await this.downloadResource({
        messageId: message.message_id,
        fileKey: imageKey,
        filename: `image-${randomBytes(4).toString('hex')}.jpg`,
        isImage: true,
      })
      if (download.ok) {
        attachments.push({
          type: 'photo',
          fileId: imageKey,
          fileName: `image${extname(download.localPath)}`,
          localPath: download.localPath,
        })
      } else if (download.reason === 'too_large') {
        anyTooLarge = true
      }
    }

    // At least one image was too big to ingest — tell the user (DMs only).
    if (anyTooLarge && message.chat_type === 'p2p') {
      this.sendText(message.chat_id, ATTACHMENT_TOO_LARGE_NOTICE).catch(() => {})
    }

    // Nothing usable survived (no text and every image download failed): log
    // and drop so the run doesn't fire an empty turn.
    if (!text && attachments.length === 0) {
      this.log.info('[lark] post message had no extractable content', {
        event: 'lark_post_empty',
        messageId: message.message_id,
        chatId: message.chat_id,
        imageCount: imageKeys.length,
      })
      return
    }

    const msg: IncomingMessage = {
      platform: 'lark',
      channelId: message.chat_id,
      messageId: message.message_id,
      senderId,
      text,
      attachments: attachments.length ? attachments : undefined,
      timestamp: parseInt(message.create_time, 10) || Date.now(),
      raw: message,
    }
    this.dispatchIncomingMessage(msg)
  }

  /**
   * Download a Lark resource (image or file) to a local temp path.
   *
   * Lark resource URLs require bearer-token auth; we can't hand a URL to the
   * router. Instead we stream the binary to a temp file and emit `localPath`,
   * matching the Telegram pattern.
   */
  private async downloadResource(args: {
    messageId: string
    fileKey: string
    filename: string
    isImage: boolean
  }): Promise<DownloadResult> {
    if (!this.client) return { ok: false, reason: 'error' }
    const ext = extname(args.filename) || (args.isImage ? '.jpg' : '.bin')
    const localPath = join(tmpdir(), `lark-${randomBytes(8).toString('hex')}${ext}`)
    try {
      // The SDK's `im.message.resource.get` returns a Node stream-like object
      // with a `writeFile` helper for the common case. We use that for size+brevity.
      const sdkResource = await (
        (this.client as unknown as {
          im: {
            messageResource: {
              get: (args: {
                path: { message_id: string; file_key: string }
                params: { type: 'image' | 'file' }
              }) => Promise<{ writeFile: (path: string) => Promise<void> } & Record<string, unknown>>
            }
          }
        }).im.messageResource.get
      )({
        path: { message_id: args.messageId, file_key: args.fileKey },
        params: { type: args.isImage ? 'image' : 'file' },
      })

      // Different SDK versions expose either `writeFile`, `file` (Buffer), or
      // a plain Node Readable. Handle the common shapes.
      if (typeof sdkResource.writeFile === 'function') {
        await sdkResource.writeFile(localPath)
        // `writeFile` streams without a size guard, so enforce the cap afterward.
        if (statSync(localPath).size > MAX_ATTACHMENT_BYTES) {
          this.safeUnlink(localPath)
          return { ok: false, reason: 'too_large' }
        }
      } else if (sdkResource.file instanceof Buffer) {
        const buf = sdkResource.file
        if (buf.length > MAX_ATTACHMENT_BYTES) {
          return { ok: false, reason: 'too_large' }
        }
        writeFileSync(localPath, buf)
      } else {
        throw new Error('Lark resource SDK returned an unsupported shape')
      }
      return { ok: true, localPath }
    } catch (err: unknown) {
      this.safeUnlink(localPath)
      this.log.warn('[lark] resource download failed', {
        event: 'lark_resource_download_failed',
        messageId: args.messageId,
        fileKey: args.fileKey,
        error: err instanceof Error ? err.message : String(err),
      })
      return { ok: false, reason: 'error' }
    }
  }

  /** Best-effort unlink that never throws (used to clean up partial downloads). */
  private safeUnlink(path: string): void {
    try {
      unlinkSync(path)
    } catch {
      // Already gone or never created — nothing to do.
    }
  }

  private async handleCardAction(data: LarkCardActionEvent): Promise<void> {
    // Visibility log: if this never fires when the user presses a button,
    // the missing piece is on the Lark Open Platform side — schema-2.0
    // cards only emit `card.action.trigger` events when the app has the
    // **Card Callback Communication** subscription enabled under
    // Events & Callbacks (separate from `im.message.receive_v1`).
    const channelId = data.context?.open_chat_id ?? data.open_chat_id ?? ''
    this.log.info('[lark] card action received', {
      event: 'lark_card_action_received',
      chatId: channelId,
      tag: data.action?.tag,
      hasValue: data.action?.value !== undefined,
    })

    if (!this.buttonHandler) return
    const value = data.action?.value as
      | { buttonId?: string; messageId?: string; data?: string }
      | undefined
    if (!value?.buttonId || !value?.messageId) {
      this.log.warn('[lark] card action missing correlation ids', {
        event: 'lark_card_action_no_ids',
        operator: data.operator,
      })
      return
    }
    const operator = data.operator
    const senderId = operator?.user_id ?? operator?.open_id ?? operator?.union_id ?? ''

    const press: ButtonPress = {
      platform: 'lark',
      channelId,
      messageId: value.messageId,
      buttonId: value.buttonId,
      senderId,
      ...(value.data !== undefined ? { data: value.data } : {}),
    }
    await this.buttonHandler(press)
  }

  private dispatchIncomingMessage(msg: IncomingMessage): void {
    const handler = this.messageHandler
    if (!handler) return
    void handler(msg).catch((err: unknown) => {
      this.log.error('[lark] inbound message handler failed', {
        event: 'lark_message_handler_failed',
        chatId: msg.channelId,
        messageId: msg.messageId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }
}
