/**
 * LarkAdapter tests — focused on pure / unit-testable surface.
 *
 * The full adapter relies on Lark's WSClient (long-polling socket) and a
 * concrete `Client` instance, neither of which can be exercised in a unit
 * test without integration infrastructure. These tests cover the credential
 * parser and confirm the adapter's static contract (capabilities, platform).
 *
 * End-to-end behaviour (event dispatch, send/edit roundtrips) is verified
 * via manual smoke against a real Lark Custom App.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { parseLarkCredentials, parseLarkPostContent, LarkAdapter } from '../adapters/lark/index'
import type { IncomingMessage } from '../types'
import { SeenMessageStore } from '../seen-message-store'

describe('parseLarkCredentials', () => {
  it('parses a valid JSON-encoded credential blob', () => {
    const creds = parseLarkCredentials(
      JSON.stringify({ appId: 'cli_abc', appSecret: 'secret', domain: 'lark' }),
    )
    expect(creds.appId).toBe('cli_abc')
    expect(creds.appSecret).toBe('secret')
    expect(creds.domain).toBe('lark')
  })

  it('accepts feishu domain', () => {
    const creds = parseLarkCredentials(
      JSON.stringify({ appId: 'cli_abc', appSecret: 'x', domain: 'feishu' }),
    )
    expect(creds.domain).toBe('feishu')
  })

  it('throws on missing token', () => {
    expect(() => parseLarkCredentials(undefined)).toThrow(/missing/i)
    expect(() => parseLarkCredentials('')).toThrow(/missing/i)
  })

  it('throws on non-JSON input', () => {
    expect(() => parseLarkCredentials('not-json')).toThrow(/JSON/i)
  })

  it('throws on missing appId or appSecret', () => {
    expect(() =>
      parseLarkCredentials(JSON.stringify({ appSecret: 'x', domain: 'lark' })),
    ).toThrow(/appId/i)
    expect(() =>
      parseLarkCredentials(JSON.stringify({ appId: 'cli_x', domain: 'lark' })),
    ).toThrow(/appSecret/i)
  })

  it('throws on invalid domain', () => {
    expect(() =>
      parseLarkCredentials(JSON.stringify({ appId: 'cli_x', appSecret: 'x', domain: 'larksuite' })),
    ).toThrow(/domain/i)
  })
})

describe('parseLarkPostContent', () => {
  it('extracts plain text from a post message', () => {
    const content = JSON.stringify({
      title: '',
      content: [[{ tag: 'text', text: 'hello ' }, { tag: 'text', text: 'world' }]],
    })
    const result = parseLarkPostContent(content)
    expect(result.text).toBe('hello world')
    expect(result.imageKeys).toEqual([])
  })

  it('collects embedded image keys (screenshot + caption)', () => {
    const content = JSON.stringify({
      content: [
        [{ tag: 'text', text: 'see this' }, { tag: 'img', image_key: 'img_v2_abc' }],
        [{ tag: 'img', image_key: 'img_v2_def' }],
      ],
    })
    const result = parseLarkPostContent(content)
    expect(result.text).toBe('see this')
    expect(result.imageKeys).toEqual(['img_v2_abc', 'img_v2_def'])
  })

  it('renders links as "label (href)" and drops @mentions', () => {
    const content = JSON.stringify({
      content: [
        [
          { tag: 'at', user_id: 'ou_bot', user_name: 'Bot' },
          { tag: 'text', text: 'check ' },
          { tag: 'a', text: 'docs', href: 'https://example.com' },
        ],
      ],
    })
    const result = parseLarkPostContent(content)
    expect(result.text).toBe('check docs (https://example.com)')
  })

  it('prepends a non-empty title', () => {
    const content = JSON.stringify({
      title: 'Report',
      content: [[{ tag: 'text', text: 'body' }]],
    })
    expect(parseLarkPostContent(content).text).toBe('Report\nbody')
  })

  it('joins multiple paragraphs with newlines', () => {
    const content = JSON.stringify({
      content: [[{ tag: 'text', text: 'line1' }], [{ tag: 'text', text: 'line2' }]],
    })
    expect(parseLarkPostContent(content).text).toBe('line1\nline2')
  })

  it('returns empty result on malformed JSON', () => {
    expect(parseLarkPostContent('not-json')).toEqual({ text: '', imageKeys: [] })
  })
})

describe('LarkAdapter — post (rich-text) inbound', () => {
  type PostEvent = {
    sender: { sender_id: { open_id: string } }
    message: {
      message_id: string
      chat_id: string
      chat_type: string
      message_type: string
      content: string
      create_time: string
    }
  }

  const bindHandle = (adapter: LarkAdapter) =>
    (
      adapter as unknown as { handleIncomingMessage: (event: PostEvent) => Promise<void> }
    ).handleIncomingMessage.bind(adapter)

  it('dispatches a text-only post message', async () => {
    const adapter = new LarkAdapter()
    // handlePostMessage guards on a truthy client; a stub is enough for the
    // text-only path (no image download happens).
    ;(adapter as unknown as { client: object }).client = { im: {} }
    const received: IncomingMessage[] = []
    adapter.onMessage(async (msg) => {
      received.push(msg)
    })

    await bindHandle(adapter)({
      sender: { sender_id: { open_id: 'ou_1' } },
      message: {
        message_id: 'om_post_text',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'post',
        content: JSON.stringify({ content: [[{ tag: 'text', text: 'just text' }]] }),
        create_time: '1779782400000',
      },
    })

    expect(received).toHaveLength(1)
    expect(received[0]?.text).toBe('just text')
    expect(received[0]?.attachments).toBeUndefined()
  })

  it('downloads embedded images and dispatches text + attachment', async () => {
    const adapter = new LarkAdapter()
    const resourceCalls: Array<{ message_id: string; file_key: string }> = []
    ;(
      adapter as unknown as {
        client: {
          im: {
            messageResource: {
              get: (args: {
                path: { message_id: string; file_key: string }
                params: { type: 'image' | 'file' }
              }) => Promise<{ writeFile: (path: string) => Promise<void> }>
            }
          }
        }
      }
    ).client = {
      im: {
        messageResource: {
          get: async (args) => {
            resourceCalls.push(args.path)
            return { writeFile: async () => {} }
          },
        },
      },
    }
    const received: IncomingMessage[] = []
    adapter.onMessage(async (msg) => {
      received.push(msg)
    })

    await bindHandle(adapter)({
      sender: { sender_id: { open_id: 'ou_1' } },
      message: {
        message_id: 'om_post_img',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'post',
        content: JSON.stringify({
          content: [[{ tag: 'text', text: 'screenshot:' }, { tag: 'img', image_key: 'img_v2_x' }]],
        }),
        create_time: '1779782400000',
      },
    })

    expect(resourceCalls).toEqual([{ message_id: 'om_post_img', file_key: 'img_v2_x' }])
    expect(received).toHaveLength(1)
    expect(received[0]?.text).toBe('screenshot:')
    expect(received[0]?.attachments).toHaveLength(1)
    expect(received[0]?.attachments?.[0]?.type).toBe('photo')
    expect(received[0]?.attachments?.[0]?.fileId).toBe('img_v2_x')
    expect(received[0]?.attachments?.[0]?.localPath).toBeTruthy()
  })
})

describe('LarkAdapter — static contract', () => {
  it('declares platform = "lark"', () => {
    const adapter = new LarkAdapter()
    expect(adapter.platform).toBe('lark')
  })

  it('reports Phase 2 capabilities (edits, buttons, lark-post)', () => {
    const adapter = new LarkAdapter()
    expect(adapter.capabilities.messageEditing).toBe(true)
    expect(adapter.capabilities.inlineButtons).toBe(true)
    expect(adapter.capabilities.markdown).toBe('lark-post')
    expect(adapter.capabilities.maxButtons).toBe(10)
    expect(adapter.capabilities.webhookSupport).toBe(false)
  })

  it('starts disconnected before initialize', () => {
    const adapter = new LarkAdapter()
    expect(adapter.isConnected()).toBe(false)
  })

  it('drops duplicate inbound message events by Lark message_id', async () => {
    const adapter = new LarkAdapter()
    const received: IncomingMessage[] = []
    adapter.onMessage(async (msg) => {
      received.push(msg)
    })

    const handleIncomingMessage = (
      adapter as unknown as {
        handleIncomingMessage: (event: {
          sender: { sender_id: { open_id: string } }
          message: {
            message_id: string
            chat_id: string
            chat_type: string
            message_type: string
            content: string
            create_time: string
          }
        }) => Promise<void>
      }
    ).handleIncomingMessage.bind(adapter)

    const event = {
      sender: { sender_id: { open_id: 'ou_1' } },
      message: {
        message_id: 'om_duplicate',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
        create_time: '1779782400000',
      },
    }

    await handleIncomingMessage(event)
    await handleIncomingMessage(event)

    expect(received).toHaveLength(1)
    expect(received[0]?.text).toBe('hello')
    expect(received[0]?.messageId).toBe('om_duplicate')
  })

  it('persists dedup across adapter instances via a shared SeenMessageStore', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-adapter-seen-'))
    try {
      const buildAdapter = () => {
        const adapter = new LarkAdapter(new SeenMessageStore(dir))
        const received: IncomingMessage[] = []
        adapter.onMessage(async (msg) => {
          received.push(msg)
        })
        const handle = (
          adapter as unknown as {
            handleIncomingMessage: (event: {
              sender: { sender_id: { open_id: string } }
              message: {
                message_id: string
                chat_id: string
                chat_type: string
                message_type: string
                content: string
                create_time: string
              }
            }) => Promise<void>
          }
        ).handleIncomingMessage.bind(adapter)
        return { adapter, received, handle }
      }

      const event = {
        sender: { sender_id: { open_id: 'ou_1' } },
        message: {
          message_id: 'om_persist',
          chat_id: 'oc_1',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
          create_time: '1779782400000',
        },
      }

      // First instance processes the message, then "shuts down" (flush to disk).
      const first = buildAdapter()
      await first.handle(event)
      expect(first.received).toHaveLength(1)
      await first.adapter.destroy()

      // Second instance (simulating a process restart) must drop the redelivery.
      const second = buildAdapter()
      await second.handle(event)
      expect(second.received).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('acks inbound text events without waiting for the message handler to finish', async () => {
    const adapter = new LarkAdapter()
    let releaseHandler!: () => void
    let handlerStarted = false
    let handlerFinished = false
    adapter.onMessage(async () => {
      handlerStarted = true
      await new Promise<void>((resolve) => {
        releaseHandler = resolve
      })
      handlerFinished = true
    })

    const handleIncomingMessage = (
      adapter as unknown as {
        handleIncomingMessage: (event: {
          sender: { sender_id: { open_id: string } }
          message: {
            message_id: string
            chat_id: string
            chat_type: string
            message_type: string
            content: string
            create_time: string
          }
        }) => Promise<void>
      }
    ).handleIncomingMessage.bind(adapter)

    await handleIncomingMessage({
      sender: { sender_id: { open_id: 'ou_1' } },
      message: {
        message_id: 'om_async',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
        create_time: '1779782400000',
      },
    })

    expect(handlerStarted).toBe(true)
    expect(handlerFinished).toBe(false)
    releaseHandler()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(handlerFinished).toBe(true)
  })

  it('extracts message ids from nested Lark create responses', async () => {
    const adapter = new LarkAdapter()
    ;(
      adapter as unknown as {
        client: {
          im: {
            message: {
              create: () => Promise<{ data: { data: { message_id: string } } }>
            }
          }
        }
      }
    ).client = {
      im: {
        message: {
          create: async () => ({ data: { data: { message_id: 'om_nested' } } }),
        },
      },
    }

    const sent = await adapter.sendText('oc_1', 'hello')

    expect(sent.messageId).toBe('om_nested')
  })

  it('falls back to plain text when Lark rejects post content', async () => {
    const adapter = new LarkAdapter()
    const creates: Array<{
      data: { receive_id: string; msg_type: string; content: string }
    }> = []
    ;(
      adapter as unknown as {
        client: {
          im: {
            message: {
              create: (args: {
                data: { receive_id: string; msg_type: string; content: string }
              }) => Promise<{ data: { message_id: string } }>
            }
          }
        }
      }
    ).client = {
      im: {
        message: {
          create: async (args) => {
            creates.push(args)
            if (args.data.msg_type === 'post') {
              throw new Error('invalid message content')
            }
            return { data: { message_id: 'om_text_fallback' } }
          },
        },
      },
    }

    const sent = await adapter.sendText('oc_1', '今天是 **2026年5月26日**，星期二。')

    expect(sent.messageId).toBe('om_text_fallback')
    expect(creates.map((call) => call.data.msg_type)).toEqual(['post', 'text'])
    expect(JSON.parse(creates[1]!.data.content)).toEqual({
      text: '今天是 2026年5月26日，星期二。',
    })
  })

  it('marks inbound messages with the GET reaction and clears it later', async () => {
    const adapter = new LarkAdapter()
    const reactions: Array<{
      path: { message_id: string }
      data: { reaction_type: { emoji_type: string } }
    }> = []
    const deletes: Array<{ path: { message_id: string; reaction_id: string } }> = []
    ;(
      adapter as unknown as {
        client: {
          im: {
            messageReaction: {
              create: (args: {
                path: { message_id: string }
                data: { reaction_type: { emoji_type: string } }
              }) => Promise<{ data: { reaction_id: string } }>
              delete: (args: { path: { message_id: string; reaction_id: string } }) => Promise<void>
            }
          }
        }
      }
    ).client = {
      im: {
        messageReaction: {
          create: async (args) => {
            reactions.push(args)
            return { data: { reaction_id: 'react_1' } }
          },
          delete: async (args) => {
            deletes.push(args)
          },
        },
      },
    }

    await adapter.markMessageReceived({
      platform: 'lark',
      channelId: 'oc_1',
      messageId: 'om_1',
      senderId: 'ou_1',
      text: 'hello',
      timestamp: Date.now(),
      raw: {},
    })

    expect(reactions).toEqual([
      {
        path: { message_id: 'om_1' },
        data: { reaction_type: { emoji_type: 'Get' } },
      },
    ])

    await adapter.clearMessageReceived({
      platform: 'lark',
      channelId: 'oc_1',
      messageId: 'om_1',
      senderId: 'ou_1',
      text: 'hello',
      timestamp: Date.now(),
      raw: {},
    })

    expect(deletes).toEqual([
      {
        path: { message_id: 'om_1', reaction_id: 'react_1' },
      },
    ])
  })

  it('closes the Lark WS client on destroy', async () => {
    const adapter = new LarkAdapter()
    const calls: Array<{ force?: boolean } | undefined> = []
    ;(
      adapter as unknown as {
        wsClient: { close: (opts?: { force?: boolean }) => void }
      }
    ).wsClient = {
      close: (opts) => {
        calls.push(opts)
      },
    }

    await adapter.destroy()

    expect(calls).toEqual([{ force: true }])
  })
})
