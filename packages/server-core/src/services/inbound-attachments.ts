/**
 * Display-side persistence for inbound messaging attachments.
 *
 * Messaging adapters (Lark/WeChat/Telegram/WhatsApp) route raw
 * `FileAttachment`s — the bytes are fed to the model, but nothing is persisted
 * for the chat UI. The desktop/web renderer draws a user message's attachments
 * from `StoredAttachment[]` (it needs `thumbnailBase64` to show an image and
 * `storedPath` to open it). Without a stored form, inbound images/files never
 * appear in the transcript even though the agent "saw" them.
 *
 * This mirrors the display-relevant slice of the `STORE_ATTACHMENT` RPC handler
 * (store-to-disk + thumbnail) without its model-input concerns (Claude resize,
 * Office→markdown) — those are driven by the raw `FileAttachment`s that the
 * session still forwards to the backend unchanged.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getSessionAttachmentsPath } from '@craft-agent/shared/sessions'
import { IMAGE_LIMITS } from '@craft-agent/shared/utils'
import type { FileAttachment } from '@craft-agent/shared/protocol'
import type { StoredAttachment } from '@craft-agent/core/types'
import { generateThumbnailBase64, resizeImageForAPI } from './image-utils'

/**
 * Sanitize a filename to prevent path traversal / filesystem issues. Inlined
 * (rather than imported from handlers) to avoid a services→handlers import
 * cycle, since handlers already depends on services. Mirrors
 * `handlers/utils.ts#sanitizeFilename`.
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\]/g, '_')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 200)
    || 'unnamed'
}

/**
 * Resize inbound image attachments that exceed Claude's per-image byte limit
 * (5MB) so they don't get rejected by the API. The desktop client runs this in
 * its `STORE_ATTACHMENT` path; messaging adapters feed raw bytes straight to the
 * model, so without this an oversized inbound image (e.g. a 9–10MB photo) makes
 * the request fail — and because the image is embedded in the conversation
 * history, the whole session becomes unrecoverable. Returns a new array only
 * when something was resized; otherwise the original is returned untouched.
 *
 * Best-effort: an image that can't be compressed below the limit is left as-is
 * (the existing oversized-image error path then surfaces it) rather than dropped.
 */
export async function compressOversizedInboundImages(
  attachments: FileAttachment[],
): Promise<FileAttachment[]> {
  let changed = false
  const out = await Promise.all(
    attachments.map(async (att): Promise<FileAttachment> => {
      if (att.type !== 'image' || !att.base64) return att
      const decoded = Buffer.from(att.base64, 'base64')
      if (decoded.length <= IMAGE_LIMITS.MAX_SIZE) return att

      const resized = await resizeImageForAPI(decoded, {
        isPhoto: att.mimeType === 'image/jpeg',
      }).catch(() => null)
      if (!resized) return att

      changed = true
      return {
        ...att,
        base64: resized.buffer.toString('base64'),
        size: resized.buffer.length,
        mimeType: resized.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      }
    }),
  )
  return changed ? out : attachments
}

/**
 * Persist inbound `FileAttachment`s to the session's attachments dir and build
 * `StoredAttachment`s for UI display (with image thumbnails). Best-effort:
 * attachments without decodable content, or that fail to write, are skipped
 * rather than failing the whole send. Returns only the successfully stored
 * attachments (possibly empty).
 */
export async function persistInboundAttachmentsForDisplay(
  workspaceRootPath: string,
  sessionId: string,
  attachments: FileAttachment[],
): Promise<StoredAttachment[]> {
  const stored: StoredAttachment[] = []
  const attachmentsDir = getSessionAttachmentsPath(workspaceRootPath, sessionId)
  let dirEnsured = false

  for (const att of attachments) {
    try {
      // Images/PDF/Office carry base64; text files carry utf-8 text.
      const bytes = att.base64
        ? Buffer.from(att.base64, 'base64')
        : att.text != null
          ? Buffer.from(att.text, 'utf-8')
          : null
      if (!bytes || bytes.length === 0) continue

      if (!dirEnsured) {
        await mkdir(attachmentsDir, { recursive: true })
        dirEnsured = true
      }

      const id = randomUUID()
      const storedPath = join(attachmentsDir, `${id}_${sanitizeFilename(att.name)}`)
      await writeFile(storedPath, bytes)

      const thumbnailBase64 =
        att.type === 'image' ? await generateThumbnailBase64(storedPath) : undefined

      stored.push({
        id,
        type: att.type,
        name: att.name,
        mimeType: att.mimeType,
        size: bytes.length,
        storedPath,
        thumbnailBase64,
      })
    } catch {
      // Best-effort display persistence — skip this attachment.
    }
  }

  return stored
}
