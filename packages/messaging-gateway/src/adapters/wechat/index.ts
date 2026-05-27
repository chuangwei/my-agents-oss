/**
 * WeChatAdapter — personal WeChat (微信) via Tencent's official iLink "ClawBot"
 * transport, vendored under ./ilink (MIT, from @tencent-weixin/openclaw-weixin).
 * Mirrors the Lark adapter shape: long-poll inbound + sendMessage outbound, no
 * public webhook. QR-login binds a personal WeChat the official way (no Wechaty,
 * no ban risk).
 *
 * v1 scope: text + inbound image/file/voice/video attachments + outbound file.
 * No inline buttons, no message editing, no streaming.
 */
import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { randomBytes } from 'node:crypto'

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

import { stripMarkdownForWeChat } from './format'
import {
  DEFAULT_BASE_URL,
  CDN_BASE_URL,
  saveWeixinAccount,
  registerWeixinAccountId,
} from './ilink/auth/accounts'
import { startWeixinLoginWithQr, waitForWeixinLogin } from './ilink/auth/login-qr'
import { monitorWeixinProvider } from './ilink/monitor/monitor'
import {
  weixinMessageToMsgContext,
  isMediaItem,
  setContextToken,
  getContextToken,
} from './ilink/messaging/inbound'
import { sendMessageWeixin } from './ilink/messaging/send'
import { sendWeixinMediaFile } from './ilink/messaging/send-media'
import { downloadMediaFromItem } from './ilink/media/media-download'
import type { WeixinMessage } from './ilink/api/types'

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface WeChatCredentials {
  accountId: string
  token: string
  baseUrl?: string
  userId?: string
}

/** Parse the JSON credential blob stored under `messaging_bearer` / name `wechat`. */
export function parseWeChatCredentials(raw: string): WeChatCredentials {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('WeChat credentials are not valid JSON')
  }
  const c = parsed as Partial<WeChatCredentials>
  if (!c.accountId || typeof c.accountId !== 'string') {
    throw new Error('WeChat credentials missing accountId')
  }
  if (!c.token || typeof c.token !== 'string') {
    throw new Error('WeChat credentials missing token')
  }
  return {
    accountId: c.accountId,
    token: c.token,
    baseUrl: typeof c.baseUrl === 'string' && c.baseUrl.trim() ? c.baseUrl : DEFAULT_BASE_URL,
    userId: typeof c.userId === 'string' ? c.userId : undefined,
  }
}

// ---------------------------------------------------------------------------
// QR login controller (driven by the registry before an adapter exists)
// ---------------------------------------------------------------------------

export type WeChatLoginEvent =
  | { type: 'qr'; qr: string }
  | { type: 'scanned' }
  | { type: 'need_verifycode' }
  | { type: 'connected'; credentials: WeChatCredentials }
  | { type: 'error'; message: string }

/**
 * Run a QR login against the iLink ClawBot endpoint. Emits events for the UI
 * (qr → [scanned] → [need_verifycode] → connected/error) and resolves with the
 * bound credentials, or null on failure.
 */
export async function startWeChatQrLogin(opts: {
  onEvent: (event: WeChatLoginEvent) => void
  verifyCodeProvider?: () => Promise<string>
  timeoutMs?: number
}): Promise<WeChatCredentials | null> {
  const start = await startWeixinLoginWithQr({ apiBaseUrl: DEFAULT_BASE_URL })
  if (!start.qrcodeUrl) {
    opts.onEvent({ type: 'error', message: start.message })
    return null
  }
  opts.onEvent({ type: 'qr', qr: start.qrcodeUrl })

  const result = await waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: DEFAULT_BASE_URL,
    timeoutMs: opts.timeoutMs,
    verifyCodeProvider: opts.verifyCodeProvider,
    onStatus: (status) => {
      if (status === 'need_verifycode') opts.onEvent({ type: 'need_verifycode' })
      else if (status === 'scaned') opts.onEvent({ type: 'scanned' })
    },
  })

  if (!result.connected || !result.accountId) {
    opts.onEvent({ type: 'error', message: result.message })
    return null
  }

  const credentials: WeChatCredentials = {
    accountId: result.accountId,
    token: result.botToken ?? '',
    baseUrl: result.baseUrl || DEFAULT_BASE_URL,
    userId: result.userId,
  }
  // Persist to the transport's on-disk cache (used by future re-logins).
  saveWeixinAccount(credentials.accountId, {
    token: credentials.token,
    baseUrl: credentials.baseUrl,
    userId: credentials.userId,
  })
  registerWeixinAccountId(credentials.accountId)
  opts.onEvent({ type: 'connected', credentials })
  return credentials
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LENGTH = 4000

/**
 * How long to wait after a media-only WeChat message for a following text
 * caption before dispatching. WeChat delivers an image and its caption as two
 * separate messages; coalescing them into one turn avoids a double reply.
 * Only media-only messages incur this wait — standalone text dispatches
 * immediately, and a following text flushes the buffer early (no full wait).
 */
const COALESCE_WINDOW_MS = 10_000

export class WeChatAdapter implements PlatformAdapter {
  readonly platform = 'wechat' as const
  readonly capabilities: AdapterCapabilities = {
    messageEditing: false,
    inlineButtons: false,
    maxButtons: 0,
    maxMessageLength: MAX_MESSAGE_LENGTH,
    markdown: 'wechat',
    webhookSupport: false,
  }

  private accountId = ''
  private token = ''
  private baseUrl = DEFAULT_BASE_URL
  private cdnBaseUrl = CDN_BASE_URL
  private userId?: string
  private connected = false
  private abort?: AbortController
  private logger?: MessagingLogger
  private messageHandler?: (msg: IncomingMessage) => Promise<void>
  private buttonHandler?: (press: ButtonPress) => Promise<void>
  /** Per-user inbound buffer: media-only messages awaiting a following caption. */
  private readonly pending = new Map<
    string,
    { msgs: WeixinMessage[]; timer: ReturnType<typeof setTimeout> }
  >()

  async initialize(config: PlatformConfig): Promise<void> {
    if (!config.token) throw new Error('WeChat adapter requires credentials in config.token')
    const creds = parseWeChatCredentials(config.token)
    this.accountId = creds.accountId
    this.token = creds.token
    this.baseUrl = creds.baseUrl ?? DEFAULT_BASE_URL
    this.userId = creds.userId
    this.logger = config.logger

    // Keep the transport's on-disk cache in sync (account index + sync buf live here).
    saveWeixinAccount(this.accountId, {
      token: this.token,
      baseUrl: this.baseUrl,
      userId: this.userId,
    })
    registerWeixinAccountId(this.accountId)

    this.abort = new AbortController()
    this.connected = true

    const log = (m: string) => this.logger?.info(m, { event: 'wechat_monitor' })
    const errLog = (m: string) => this.logger?.error(m, { event: 'wechat_monitor' })

    // Fire-and-forget the long-poll loop; it runs until destroy() aborts it.
    void monitorWeixinProvider({
      baseUrl: this.baseUrl,
      token: this.token,
      accountId: this.accountId,
      abortSignal: this.abort.signal,
      runtime: { log, error: errLog },
      onMessage: (msg) => this.handleInbound(msg),
    }).catch((err) => {
      this.connected = false
      this.logger?.error(`wechat monitor stopped: ${String(err)}`, {
        event: 'wechat_monitor_stopped',
      })
    })
  }

  async destroy(): Promise<void> {
    this.connected = false
    this.abort?.abort()
    this.abort = undefined
    for (const entry of this.pending.values()) clearTimeout(entry.timer)
    this.pending.clear()
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

  /** Identity helper used by the registry (mirrors LarkAdapter.getBotInfo). */
  getBotInfo(): { name?: string } {
    return { name: this.userId || this.accountId }
  }

  async sendText(channelId: string, text: string, _opts?: SendOptions): Promise<SentMessage> {
    const plain = stripMarkdownForWeChat(text)
    const { messageId } = await sendMessageWeixin({
      to: channelId,
      text: plain,
      opts: {
        baseUrl: this.baseUrl,
        token: this.token,
        contextToken: getContextToken(this.accountId, channelId),
      },
    })
    return { platform: 'wechat', channelId, messageId }
  }

  async editMessage(
    _channelId: string,
    _messageId: string,
    _text: string,
    _opts?: SendOptions,
  ): Promise<void> {
    // No-op for v1 (capabilities.messageEditing = false): the renderer never
    // calls this, but the interface requires the method to exist.
  }

  async sendButtons(
    channelId: string,
    text: string,
    _buttons: InlineButton[],
    opts?: SendOptions,
  ): Promise<SentMessage> {
    // v1: no inline buttons (capabilities.inlineButtons = false). Send text only.
    return this.sendText(channelId, text, opts)
  }

  async sendTyping(_channelId: string, _opts?: SendOptions): Promise<void> {
    // No-op for v1: WeChat typing requires a per-user typing_ticket (getConfig).
  }

  async sendFile(
    channelId: string,
    file: Buffer,
    filename: string,
    caption?: string,
    _opts?: SendOptions,
  ): Promise<SentMessage> {
    const dir = join(tmpdir(), 'craft-wechat-media', 'outbound')
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, `${randomBytes(8).toString('hex')}-${filename}`)
    writeFileSync(filePath, file)
    try {
      const { messageId } = await sendWeixinMediaFile({
        filePath,
        to: channelId,
        text: caption ?? '',
        opts: {
          baseUrl: this.baseUrl,
          token: this.token,
          contextToken: getContextToken(this.accountId, channelId),
        },
        cdnBaseUrl: this.cdnBaseUrl,
      })
      return { platform: 'wechat', channelId, messageId }
    } finally {
      try {
        unlinkSync(filePath)
      } catch {
        // best-effort cleanup
      }
    }
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  private saveMedia = async (
    buffer: Buffer,
    contentType?: string,
    subdir?: string,
    _maxBytes?: number,
    originalFilename?: string,
  ): Promise<{ path: string }> => {
    const dir = join(tmpdir(), 'craft-wechat-media', subdir ?? 'inbound')
    mkdirSync(dir, { recursive: true })
    // The saved file MUST carry a correct extension: downstream
    // `readFileAttachment()` infers attachment type + MIME from the path, and
    // only reads images as base64 for the LLM when type === 'image'. iLink CDN
    // images arrive with no content-type/filename, so sniff their magic bytes.
    let ext = originalFilename ? extname(originalFilename) : ''
    if (!ext && contentType) ext = extFromMime(contentType)
    if (!ext) ext = sniffImageExt(buffer) ?? '.jpg'
    const filePath = join(dir, `${randomBytes(8).toString('hex')}${ext}`)
    writeFileSync(filePath, buffer)
    return { path: filePath }
  }

  private async handleInbound(msg: WeixinMessage): Promise<void> {
    if (!this.messageHandler) return
    const from = msg.from_user_id ?? ''
    if (!from) return

    // The context_token must be echoed on every outbound reply to this user;
    // keep the latest so a coalesced reply uses a still-valid token.
    if (msg.context_token) setContextToken(this.accountId, from, msg.context_token)

    const hasText = (weixinMessageToMsgContext(msg, this.accountId).Body ?? '').trim().length > 0
    const hasMedia = (msg.item_list ?? []).some(isMediaItem)

    const entry = this.pending.get(from)
    if (entry) {
      // Already buffering for this user (a media message is awaiting a caption).
      clearTimeout(entry.timer)
      entry.msgs.push(msg)
      if (hasText) {
        // A follow-up text completes the image+caption unit → dispatch now.
        await this.flushPending(from)
      } else {
        // More media — keep waiting for a possible caption.
        entry.timer = setTimeout(() => void this.flushPending(from), COALESCE_WINDOW_MS)
      }
      return
    }

    if (hasMedia && !hasText) {
      // Media-only: WeChat sends an image and its caption as separate messages.
      // Buffer briefly so a following text merges into one turn (one reply)
      // instead of triggering a second turn.
      const timer = setTimeout(() => void this.flushPending(from), COALESCE_WINDOW_MS)
      this.pending.set(from, { msgs: [msg], timer })
      return
    }

    // Standalone text (or a single message already carrying everything): no delay.
    await this.dispatchBatch([msg])
  }

  private async flushPending(from: string): Promise<void> {
    const entry = this.pending.get(from)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(from)
    await this.dispatchBatch(entry.msgs)
  }

  /** Merge one or more buffered WeChat messages into a single IncomingMessage. */
  private async dispatchBatch(msgs: WeixinMessage[]): Promise<void> {
    if (!this.messageHandler || msgs.length === 0) return
    const last = msgs[msgs.length - 1]!
    const from = last.from_user_id ?? ''
    if (!from) return

    const text = msgs
      .map((m) => (weixinMessageToMsgContext(m, this.accountId).Body ?? '').trim())
      .filter((t) => t.length > 0)
      .join('\n')

    const attachments: IncomingAttachment[] = []
    for (const m of msgs) {
      attachments.push(...(await this.collectAttachments(m)))
    }

    const incoming: IncomingMessage = {
      platform: 'wechat',
      channelId: from,
      messageId: String(last.message_id ?? last.client_id ?? randomBytes(8).toString('hex')),
      senderId: from,
      text,
      attachments: attachments.length ? attachments : undefined,
      timestamp: last.create_time_ms ?? Date.now(),
      raw: msgs,
    }

    await this.messageHandler(incoming)
  }

  private async collectAttachments(msg: WeixinMessage): Promise<IncomingAttachment[]> {
    const out: IncomingAttachment[] = []
    const log = (m: string) => this.logger?.info(m, { event: 'wechat_media' })
    const errLog = (m: string) => this.logger?.error(m, { event: 'wechat_media' })
    for (const item of msg.item_list ?? []) {
      if (!isMediaItem(item)) continue
      const media = await downloadMediaFromItem(item, {
        cdnBaseUrl: this.cdnBaseUrl,
        saveMedia: this.saveMedia,
        log,
        errLog,
        label: 'inbound',
      })
      const fileId = item.msg_id ?? randomBytes(6).toString('hex')
      if (media.decryptedPicPath) {
        out.push({
          type: 'photo',
          fileId,
          localPath: media.decryptedPicPath,
          fileName: `image${extname(media.decryptedPicPath)}`,
          mimeType: 'image/jpeg',
        })
      } else if (media.decryptedFilePath) {
        out.push({
          type: 'document',
          fileId,
          localPath: media.decryptedFilePath,
          mimeType: media.fileMediaType,
          fileName: item.file_item?.file_name,
        })
      } else if (media.decryptedVideoPath) {
        out.push({
          type: 'video',
          fileId,
          localPath: media.decryptedVideoPath,
          fileName: `video${extname(media.decryptedVideoPath)}`,
          mimeType: 'video/mp4',
        })
      } else if (media.decryptedVoicePath) {
        out.push({
          type: 'voice',
          fileId,
          localPath: media.decryptedVoicePath,
          fileName: `voice${extname(media.decryptedVoicePath)}`,
          mimeType: media.voiceMediaType,
        })
      }
    }
    return out
  }
}

/**
 * Sniff common image magic bytes to choose a file extension. iLink CDN images
 * arrive with no content-type, and `readFileAttachment()` classifies by path
 * extension — so an extension-less image is wrongly read as a text file.
 * Returns undefined for non-image data.
 */
export function sniffImageExt(buf: Buffer): string | undefined {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg'
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  )
    return '.png'
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif'
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  )
    return '.webp'
  return undefined
}

function extFromMime(mime?: string): string {
  if (!mime) return ''
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg'
  if (mime.includes('png')) return '.png'
  if (mime.includes('gif')) return '.gif'
  if (mime.includes('webp')) return '.webp'
  if (mime.includes('mp4')) return '.mp4'
  if (mime.includes('wav')) return '.wav'
  if (mime.includes('silk')) return '.silk'
  if (mime.includes('pdf')) return '.pdf'
  return ''
}
