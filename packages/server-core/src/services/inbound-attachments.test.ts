import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileAttachment } from '@craft-agent/shared/protocol'
import { getSessionAttachmentsPath } from '@craft-agent/shared/sessions'
import type { ImageProcessor } from '../runtime/platform'
import { setImageProcessor } from './image-utils'
import {
  persistInboundAttachmentsForDisplay,
  compressOversizedInboundImages,
} from './inbound-attachments'

const SESSION_ID = '11111111-1111-1111-1111-111111111111'
const THUMB_PNG = Buffer.from('fake-thumbnail-png')

let workspaceRoot: string

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'inbound-att-'))
  // Stub the module-level image processor used by generateThumbnailBase64.
  const processor: ImageProcessor = {
    getMetadata: async () => ({ width: 64, height: 64 }),
    process: async () => THUMB_PNG,
  }
  setImageProcessor(processor)
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
})

function imageAttachment(overrides: Partial<FileAttachment> = {}): FileAttachment {
  return {
    type: 'image',
    path: '/tmp/sticker.webp',
    name: 'sticker.webp',
    mimeType: 'image/webp',
    size: 9,
    base64: Buffer.from('imagedata').toString('base64'),
    ...overrides,
  }
}

describe('persistInboundAttachmentsForDisplay', () => {
  it('stores an inbound image and produces a thumbnail for display', async () => {
    const result = await persistInboundAttachmentsForDisplay(workspaceRoot, SESSION_ID, [
      imageAttachment(),
    ])

    expect(result).toHaveLength(1)
    const stored = result[0]!
    expect(stored.type).toBe('image')
    expect(stored.name).toBe('sticker.webp')
    expect(stored.mimeType).toBe('image/webp')
    expect(stored.thumbnailBase64).toBe(THUMB_PNG.toString('base64'))

    // File actually written under the session attachments dir.
    const attachmentsDir = getSessionAttachmentsPath(workspaceRoot, SESSION_ID)
    expect(stored.storedPath.startsWith(attachmentsDir)).toBe(true)
    expect(existsSync(stored.storedPath)).toBe(true)
    expect(readFileSync(stored.storedPath).toString()).toBe('imagedata')
  })

  it('stores text attachments without a thumbnail', async () => {
    const result = await persistInboundAttachmentsForDisplay(workspaceRoot, SESSION_ID, [
      { type: 'text', path: '/tmp/n.txt', name: 'n.txt', mimeType: 'text/plain', size: 5, text: 'hello' },
    ])

    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('text')
    expect(result[0]!.thumbnailBase64).toBeUndefined()
    expect(readFileSync(result[0]!.storedPath, 'utf-8')).toBe('hello')
  })

  it('skips attachments that carry no decodable content', async () => {
    const result = await persistInboundAttachmentsForDisplay(workspaceRoot, SESSION_ID, [
      imageAttachment({ base64: undefined }),
    ])
    expect(result).toHaveLength(0)
  })

  it('falls back to no thumbnail when the image processor fails, still storing the file', async () => {
    setImageProcessor({
      getMetadata: async () => null,
      process: async () => {
        throw new Error('sharp exploded')
      },
    })

    const result = await persistInboundAttachmentsForDisplay(workspaceRoot, SESSION_ID, [
      imageAttachment(),
    ])

    expect(result).toHaveLength(1)
    expect(result[0]!.thumbnailBase64).toBeUndefined()
    expect(existsSync(result[0]!.storedPath)).toBe(true)
  })
})

describe('compressOversizedInboundImages', () => {
  const oversized = Buffer.alloc(6 * 1024 * 1024, 1) // 6MB > 5MB Claude limit
  const small = Buffer.from('tiny-resized')

  function bigImage(overrides: Partial<FileAttachment> = {}): FileAttachment {
    return {
      type: 'image',
      path: '/tmp/big.webp',
      name: 'big.webp',
      mimeType: 'image/webp',
      size: oversized.length,
      base64: oversized.toString('base64'),
      ...overrides,
    }
  }

  it('resizes an image that exceeds the 5MB limit and updates size/mimeType', async () => {
    setImageProcessor({
      getMetadata: async () => ({ width: 4000, height: 3000 }),
      process: async () => small, // always returns a tiny buffer (well under limit)
    })

    const result = await compressOversizedInboundImages([bigImage()])

    expect(result).toHaveLength(1)
    expect(result[0]!.size).toBe(small.length)
    expect(result[0]!.base64).toBe(small.toString('base64'))
    // non-photo (webp) resizes to PNG
    expect(result[0]!.mimeType).toBe('image/png')
  })

  it('leaves a within-limit image untouched (same array reference)', async () => {
    setImageProcessor({
      getMetadata: async () => ({ width: 64, height: 64 }),
      process: async () => small,
    })
    const input = [imageAttachment()] // ~small base64
    const result = await compressOversizedInboundImages(input)
    expect(result).toBe(input)
  })

  it('leaves the original when the image cannot be compressed under the limit', async () => {
    // process keeps returning an oversized buffer → resizeImageForAPI gives up (null)
    setImageProcessor({
      getMetadata: async () => ({ width: 4000, height: 3000 }),
      process: async () => oversized,
    })
    const original = bigImage()
    const result = await compressOversizedInboundImages([original])
    expect(result[0]!.base64).toBe(original.base64)
    expect(result[0]!.size).toBe(original.size)
  })

  it('ignores non-image attachments', async () => {
    const input: FileAttachment[] = [
      { type: 'text', path: '/tmp/n.txt', name: 'n.txt', mimeType: 'text/plain', size: 5, text: 'hello' },
    ]
    const result = await compressOversizedInboundImages(input)
    expect(result).toBe(input)
  })
})
