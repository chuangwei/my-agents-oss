/**
 * Markdown → Lark `post` converter tests.
 *
 * Feishu `post` only renders Markdown via the dedicated `md` tag (the `text`
 * tag rejects `style`/`code_block` on send → error 230001). So any input with
 * Markdown cues is emitted as a single `md` element carrying the raw Markdown;
 * plain prose stays on the lighter `text` message type.
 */
import { describe, expect, it } from 'bun:test'
import { formatForLarkPost, wrapAsTrivialPost, type LarkFormatted } from '../format'

/** Pull the single `md` element's text out of a formatted post result. */
function mdText(result: LarkFormatted): string {
  expect(result.kind).toBe('post')
  if (result.kind !== 'post') throw new Error('expected post')
  const content = result.post.post.zh_cn.content
  expect(content.length).toBe(1)
  expect(content[0]!.length).toBe(1)
  const el = content[0]![0]!
  expect(el.tag).toBe('md')
  if (el.tag !== 'md') throw new Error('expected md element')
  return el.text
}

describe('formatForLarkPost — plain text path', () => {
  it('returns kind: text for input with no formatting', () => {
    const result = formatForLarkPost('Hello, world. No markdown here.')
    expect(result.kind).toBe('text')
    if (result.kind === 'text') {
      expect(result.text).toBe('Hello, world. No markdown here.')
    }
  })

  it('keeps multi-line prose without markdown on the text path', () => {
    const result = formatForLarkPost('Line 1\nLine 2\nLine 3')
    expect(result.kind).toBe('text')
  })

  it('does not treat a stray asterisk or underscore as markdown', () => {
    expect(formatForLarkPost('2 * 3 = 6').kind).toBe('text')
    expect(formatForLarkPost('file_name_here is fine').kind).toBe('text')
  })
})

describe('formatForLarkPost — md tag (rich content)', () => {
  it('routes **bold** through a single md element with the raw markdown', () => {
    const result = formatForLarkPost('Some **bold** text')
    expect(mdText(result)).toBe('Some **bold** text')
  })

  it('routes *italic* / _italic_ through md', () => {
    expect(mdText(formatForLarkPost('Some *italic* text'))).toBe('Some *italic* text')
    expect(mdText(formatForLarkPost('Some _italic_ text'))).toBe('Some _italic_ text')
  })

  it('routes ~~strike~~ through md', () => {
    expect(mdText(formatForLarkPost('A ~~strike~~ word'))).toBe('A ~~strike~~ word')
  })

  it('routes inline `code` through md', () => {
    expect(mdText(formatForLarkPost('Use `npm install` here'))).toBe('Use `npm install` here')
  })

  it('routes [label](url) links through md', () => {
    const md = 'Visit [our docs](https://example.com/docs) here'
    expect(mdText(formatForLarkPost(md))).toBe(md)
  })

  it('routes fenced code blocks through md, preserving the fence + language', () => {
    const md = '```python\nprint("hi")\n```'
    expect(mdText(formatForLarkPost(md))).toBe(md)
  })

  it('routes headings through md', () => {
    expect(mdText(formatForLarkPost('## Section Title'))).toBe('## Section Title')
  })

  it('routes unordered + ordered lists through md verbatim', () => {
    expect(mdText(formatForLarkPost('- first\n- second'))).toBe('- first\n- second')
    expect(mdText(formatForLarkPost('1. alpha\n2. beta'))).toBe('1. alpha\n2. beta')
  })

  it('routes blockquotes through md', () => {
    expect(mdText(formatForLarkPost('> quoted line'))).toBe('> quoted line')
  })

  it('routes GFM tables through md verbatim so Feishu renders them natively', () => {
    const md = '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 5 |'
    expect(mdText(formatForLarkPost(md))).toBe(md)
  })

  it('preserves CJK table content untouched (no manual padding)', () => {
    const md = '| 姓名 | 年龄 |\n| --- | --- |\n| 张三 | 30 |\n| 李 | 5 |'
    expect(mdText(formatForLarkPost(md))).toBe(md)
  })

  it('keeps multi-paragraph markdown in one md element', () => {
    const md = 'First paragraph with **bold**.\n\nSecond paragraph.'
    expect(mdText(formatForLarkPost(md))).toBe(md)
  })

  it('does not treat a single piped line as a table', () => {
    // No leading/trailing pipe on the line → not a table row, no other cues.
    expect(formatForLarkPost('a | b | c').kind).toBe('text')
  })
})

describe('wrapAsTrivialPost', () => {
  it('produces a single-paragraph post with one plain text element', () => {
    const post = wrapAsTrivialPost('Hello there')
    expect(post.post.zh_cn.content.length).toBe(1)
    expect(post.post.zh_cn.content[0]!.length).toBe(1)
    const el = post.post.zh_cn.content[0]![0]!
    expect(el.tag).toBe('text')
    if (el.tag === 'text') {
      expect(el.text).toBe('Hello there')
    }
  })
})
