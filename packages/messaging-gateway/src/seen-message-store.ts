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
