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
