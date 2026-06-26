/**
 * Markdown → Lark `post` converter.
 *
 * Feishu's `post` rich-text type only accepts a fixed set of element tags
 * (`text`, `a`, `at`, `img`, `media`, `emotion`, `hr`, `md`). Crucially, on the
 * SEND path the `text` tag does NOT accept a `style` field and there is no
 * inline table/heading element — sending `style`/`code_block` gets rejected with
 * error 230001 ("invalid message content"), which is what silently forced every
 * formatted reply to fall back to plain text.
 *
 * The robust way to render Markdown is the dedicated `md` tag, which Feishu
 * renders natively with CommonMark 0.31 + GFM (bold, italic, strikethrough,
 * links, ordered/unordered lists, task lists, tables, code blocks, headings,
 * blockquotes). The `md` tag must occupy its own paragraph and is send-only
 * (Feishu degrades it to `text` tags when the message is later fetched, which
 * is fine — we only ever send it).
 *
 * Returns `{ kind: 'text', text }` when the input has no Markdown cues so the
 * adapter can dispatch the lighter `text` message type; returns
 * `{ kind: 'post', post }` (a single `md` element) otherwise.
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json
 */

export type LarkPostElement =
  | { tag: 'text'; text: string }
  | { tag: 'md'; text: string }

export interface LarkPost {
  post: {
    zh_cn: {
      content: LarkPostElement[][]
    }
  }
}

export type LarkFormatted =
  | { kind: 'text'; text: string }
  | { kind: 'post'; post: LarkPost }

/**
 * Convert agent Markdown output to a Lark wire payload.
 *
 * If the text contains any Markdown cue (bold/italic/strikethrough/inline code,
 * links, headings, lists, tables, blockquotes, fenced code), it is emitted as a
 * single `md` element so Feishu renders it natively. Otherwise the original
 * plain text is returned for the lighter `text` message type.
 */
export function formatForLarkPost(markdown: string): LarkFormatted {
  const trimmed = markdown.replace(/\r\n/g, '\n').replace(/\s+$/, '')

  if (!hasMarkdown(trimmed)) {
    return { kind: 'text', text: trimmed }
  }

  return {
    kind: 'post',
    post: { post: { zh_cn: { content: [[{ tag: 'md', text: trimmed }]] } } },
  }
}

/**
 * Wrap arbitrary text as a trivial post message. Used by `editMessage` when the
 * original send was a `post` and the edit content has no formatting — Lark
 * requires the new `msg_type` to match the original.
 */
export function wrapAsTrivialPost(text: string): LarkPost {
  return {
    post: {
      zh_cn: {
        content: [[{ tag: 'text', text }]],
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Heuristic: does the text contain any Markdown formatting worth rendering via
 * the `md` tag? Kept conservative so plain prose (which may contain a stray `*`
 * or `_`) isn't needlessly routed through the Markdown renderer.
 */
function hasMarkdown(text: string): boolean {
  // Inline emphasis / code / links.
  if (/\*\*[^\s*][\s\S]*?\*\*/.test(text)) return true // **bold**
  if (/~~[^\s~][\s\S]*?~~/.test(text)) return true // ~~strike~~
  if (/(^|[^\w*])\*[^\s*][^*\n]*?\*(?=[^\w*]|$)/.test(text)) return true // *italic*
  if (/(^|[^\w_])_[^\s_][^_\n]*?_(?=[^\w_]|$)/.test(text)) return true // _italic_
  if (/`[^`\n]+`/.test(text)) return true // `inline code`
  if (/```/.test(text)) return true // fenced code block
  if (/\[[^\]]+\]\((https?:[^)\s]+)\)/.test(text)) return true // [label](url)

  // Block-level cues, evaluated per line.
  for (const line of text.split('\n')) {
    if (/^\s{0,3}#{1,6}\s+\S/.test(line)) return true // heading
    if (/^\s*([-*+]|\d+\.)\s+\S/.test(line)) return true // list item
    if (/^\s*>\s+/.test(line)) return true // blockquote
    if (/^\s*\|.*\|\s*$/.test(line)) return true // table row
  }

  return false
}
