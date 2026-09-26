/**
 * Obsidian's way of writing, taught to the Markdown parser and writer underneath the editor.
 *
 * Reading: `[[wiki links]]` and `![[embeds]]` are taken whole before CommonMark looks at them, so nothing inside
 * becomes emphasis and `[[x]]` never turns into a reference link. They reach the editor as plain text; decorations
 * (live.ts) make them look like links, and the text stays editable like in Obsidian's live preview.
 *
 * Writing: remark escapes characters that could start Markdown syntax. For Obsidian's own syntax that changes the
 * meaning (`\[\[x\]\]` is no link, `\#tag` no tag, `\==x==` no highlight), so the writer for plain text leaves these
 * spans exactly as they are and escapes only the rest.
 *
 * What the editor has no node for (link definitions, reference links) is kept as raw Markdown: a block or an inline
 * atom holding its source text, written back unchanged. Nothing the editor opens is dropped. Links remember whether
 * they were written bare, in angle brackets or in square brackets.
 */
import type { Code as CodeNode, Html, Link, List, ListItem, Parents, Root, Text } from 'mdast'
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown'
import type { Info, Options as ToMarkdownOptions, State } from 'mdast-util-to-markdown'
import type { Code, Construct, Effects, Extension, State as TokenState, TokenizeContext } from 'micromark-util-types'
import { visit } from 'unist-util-visit'

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    nxWiki: 'nxWiki'
  }
}

const BANG = 33
const LEFT = 91
const BACKSLASH = 92
const RIGHT = 93

const lineEnding = (code: Code) => code !== null && code < -2

function tokenizeWiki(this: TokenizeContext, effects: Effects, ok: TokenState, nok: TokenState): TokenState {
  let size = 0
  const start: TokenState = (code) => {
    effects.enter('nxWiki')
    if (code === BANG) {
      effects.consume(code)
      return first
    }
    return first(code)
  }
  const first: TokenState = (code) => {
    if (code !== LEFT) return nok(code)
    effects.consume(code)
    return second
  }
  const second: TokenState = (code) => {
    if (code !== LEFT) return nok(code)
    effects.consume(code)
    return inside
  }
  const inside: TokenState = (code) => {
    if (code === null || code === LEFT || lineEnding(code)) return nok(code)
    if (code === RIGHT) {
      if (!size) return nok(code)
      effects.consume(code)
      return close
    }
    effects.consume(code)
    size++
    return code === BACKSLASH ? escaped : inside
  }
  const escaped: TokenState = (code) => {
    if (code === null || lineEnding(code)) return nok(code)
    effects.consume(code)
    return inside
  }
  const close: TokenState = (code) => {
    if (code !== RIGHT) return nok(code)
    effects.consume(code)
    effects.exit('nxWiki')
    return ok
  }
  return start
}

const wiki: Construct = { name: 'nxWiki', tokenize: tokenizeWiki }

/** micromark: `[[…]]` and `![[…]]` on one line, tried before links and images. */
export const wikiSyntax: Extension = { text: { [BANG]: wiki, [LEFT]: wiki } }

/** mdast: the whole span as one text node, its source unchanged (escapes included). */
export const wikiFromMarkdown: FromMarkdownExtension = {
  enter: {
    nxWiki(token) {
      this.enter({ type: 'text', value: this.sliceSerialize(token) }, token)
    },
  },
  exit: {
    nxWiki(token) {
      this.exit(token)
    },
  },
}

/**
 * Spans in plain text that are written exactly as they stand. Order matters: the first alternative that matches at
 * a place wins.
 */
const PROTECTED = new RegExp(
  [
    String.raw`!?\[\[[^\[\]\n]+\]\]`, // wiki link, embed
    String.raw`<%[\s\S]*?%>`, // Templater
    String.raw`%%[\s\S]*?%%`, // Obsidian comment
    String.raw`(?<![=\\])==(?=[^\s=])|(?<=[^\s=])==(?!=)`, // highlight markers, not a setext underline
    String.raw`(?<![\p{L}\p{N}_&/\\#])#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*`, // tag, not a heading
    // A web address typed as text: remark would write `https\://`, and remark-gfm links it on reading anyway. Only
    // with a blank or the end after it; an escape right after it would be taken into the address.
    String.raw`(?<![\p{L}\p{N}\\])https?://[^\s<>\[\]*_~` + '`' + String.raw`\\]*[^\s<>\[\]*_~.,:;!?()'"` + '`' + String.raw`\\](?=\s|$)`,
  ].join('|'),
  'gu',
)

/** Obsidian's callout marker, only at the start of a quote: `[!note]`, `[!warning]-`, `[!tip]+`. */
const CALLOUT = /^\[![\w-]+\][+-]?/

export type Piece = { text: string; raw: boolean }

/** Plain text cut into pieces written as they are (`raw`) and pieces remark may escape. */
export function pieces(value: string, calloutAllowed = false): Piece[] {
  const out: Piece[] = []
  let offset = 0
  if (calloutAllowed) {
    const marker = CALLOUT.exec(value)
    if (marker) {
      out.push({ text: marker[0], raw: true })
      offset = marker[0].length
    }
  }
  const rest = value.slice(offset)
  let last = 0
  for (const match of rest.matchAll(PROTECTED)) {
    if (match.index > last) out.push({ text: rest.slice(last, match.index), raw: false })
    out.push({ text: match[0], raw: true })
    last = match.index + match[0].length
  }
  if (last < rest.length) out.push({ text: rest.slice(last), raw: false })
  return out
}

/** In a table cell a bare `|` ends the cell; inside a wiki link Obsidian writes it as `\|`. */
function forTable(raw: string): string {
  return /^!?\[\[/.test(raw) ? raw.replace(/(?<!\\)\|/g, '\\|') : raw
}

/**
 * Text escaped where Markdown needs it, blanks never as character references. Trailing blanks are added as they
 * are (`safe` would write the last one as `&#x20;`), like Milkdown does. Milkdown skipped escaping altogether for
 * text ending in blanks without `*`, `_` or `\`; so `- ` or `# ` at the start of a paragraph came back as a list or
 * a heading.
 */
function safeText(state: State, value: string, info: Info): string {
  const trailing = /\s+$/.exec(value)?.[0] ?? ''
  if (!trailing) return state.safe(value, { ...info, encode: [] })
  const body = value.slice(0, value.length - trailing.length)
  return (body ? state.safe(body, { ...info, after: trailing.charAt(0), encode: [] }) : '') + trailing
}

export function writeText(node: Text, parent: Parents | undefined, state: State, info: Info): string {
  const inQuote = state.stack.includes('blockquote')
  const first = parent?.type === 'paragraph' && parent.children[0] === node
  const parts = pieces(node.value, inQuote && first)
  if (parts.length === 1 && !parts[0].raw) return safeText(state, node.value, info)
  const inCell = (state.stack as string[]).includes('tableCell')
  return parts
    .map((part, index) => {
      if (part.raw) return inCell ? forTable(part.text) : part.text
      const before = index === 0 ? info.before : parts[index - 1].text.slice(-1)
      const after = index === parts.length - 1 ? info.after : parts[index + 1].text.charAt(0)
      return safeText(state, part.text, { ...info, before, after })
    })
    .join('')
}

/** Raw Markdown is written as it came. */
export const writeRaw = (node: Html) => node.value

/**
 * How a link was written: `bare` (`https://…`, found by GFM), `angle` (`<https://…>`) or in brackets. Kept on the
 * link from parsing to writing, so a web address stays the way it was.
 */
export type LinkForm = 'bare' | 'angle' | ''

/**
 * A link whose text is its address, written bare where it was bare, and for new links when the author writes them
 * bare; only where GFM finds it again by itself.
 */
export function formLink(fallback: NonNullable<ToMarkdownOptions['handlers']>['link'], bareByDefault: boolean) {
  const bareText = (node: Link, info: Pick<Info, 'before' | 'after'>): string | null => {
    const form = (node.data as { nxForm?: LinkForm } | undefined)?.nxForm ?? ''
    const only = node.children.length === 1 && node.children[0].type === 'text' ? node.children[0].value : null
    const bare =
      (form === 'bare' || (form === '' && bareByDefault)) &&
      only !== null &&
      only === node.url &&
      !node.title &&
      /^https?:\/\/[^\s<>]+$/.test(only) &&
      !/[.,:;!?)\]*_~'"]$/.test(only) &&
      /^$|[\s*_~(]$/.test(info.before) &&
      /^$|^[\s.,:;!?)*_~]/.test(info.after)
    return bare ? only : null
  }
  const handle = (node: Link, parent: Parents | undefined, state: State, info: Info): string =>
    bareText(node, info) ?? fallback!(node, parent, state, info)
  return withPeek(handle, (node: Link, parent, state, info) => (bareText(node, info) ?? '').charAt(0) || peekOf(fallback)(node as never, parent, state, info))
}

/**
 * remark asks the next node for its first character before writing the current one. It uses a handler's `peek`
 * when it has one, and calls the whole handler otherwise; for bold that leaves a note to encode a neighbouring
 * character behind, and the next bold came out as `&#x2A;*…**`. Every wrapped handler therefore brings a `peek`.
 */
type Peek = (node: never, parent: Parents | undefined, state: State, info: Info) => string
function withPeek<T extends object>(handle: T, peek: Peek): T {
  return Object.assign(handle, { peek })
}
function peekOf(handler: unknown): Peek {
  const peek = (handler as { peek?: Peek } | undefined)?.peek
  return peek ?? (() => '')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- remark's handlers take any node
type Handler = (node: any, parent: Parents | undefined, state: State, info: Info) => string

/** Runs a handler with some writer options changed, and puts them back afterwards. */
function withOptions(state: State, change: Partial<State['options']>, run: () => string): string {
  const saved = Object.fromEntries(Object.keys(change).map((key) => [key, state.options[key as keyof State['options']]]))
  Object.assign(state.options, change)
  try {
    return run()
  } finally {
    Object.assign(state.options, saved)
  }
}

/** A list with the marker it was written with (see `markedList` in obsidian.ts). */
export function markedListWriter(fallback: Handler) {
  return (node: List, parent: Parents | undefined, state: State, info: Info): string => {
    const marker = (node.data as { nxMarker?: string } | undefined)?.nxMarker ?? ''
    const change: Partial<State['options']> = {}
    if (node.ordered && (marker === '.' || marker === ')')) change.bulletOrdered = marker
    if (!node.ordered && (marker === '-' || marker === '*' || marker === '+')) {
      change.bullet = marker
      change.bulletOther = marker === '-' ? '*' : '-'
    }
    return withOptions(state, change, () => fallback!(node, parent, state, info))
  }
}

/**
 * Bold and italic with the marker they were written with, through remark's own writer: Milkdown's simplified one
 * lost bold next to punctuation (`%**% x&**a` is no bold in CommonMark; remark writes the edge as a character
 * reference) and wrote bold blanks as `****`.
 */
export function attention(kind: 'strong' | 'emphasis', fallback: Handler) {
  type Node = { marker?: string; children: Parents['children'] }
  const blank = (node: Node) => node.children.every((child) => child.type === 'text' && !child.value.trim())
  const marker = (node: Node, state: State) => (node.marker === '*' || node.marker === '_' ? node.marker : state.options[kind] ?? '*')
  const handle = (node: Node, parent: Parents | undefined, state: State, info: Info): string => {
    // Only blanks inside: nothing to mark.
    if (blank(node)) return state.containerPhrasing(node as never, info)
    return withOptions(state, { [kind]: marker(node, state) }, () => fallback(node, parent, state, info))
  }
  return withPeek(handle, (node: Node, _parent, state) => (blank(node) ? ' ' : marker(node, state)))
}

type Phrasing = { type: string; marker?: string; children?: Phrasing[] }
const ATTENTION = new Set(['strong', 'emphasis', 'delete'])
const STARS = new Set(['strong', 'emphasis'])

/**
 * Marks as the editor has them can make runs of stars Markdown cannot read back: bold that starts inside italic
 * and goes on after it (`*kurs**iv*****,**`), or two bold runs next to each other (`**a****b**`). Before writing:
 * - neighbours of the same kind become one (`**ab**`);
 * - italic whose stars would touch the stars of bold is written with `_` (`_kurs**iv**_**,**`), which CommonMark
 *   cannot confuse with them.
 * What is marked stays the same.
 */
export function tidyAttention(node: Phrasing, insideStars = false): void {
  const children = node.children
  if (!children) return
  for (let i = 0; i + 1 < children.length; ) {
    const a = children[i]
    const b = children[i + 1]
    if (ATTENTION.has(a.type) && a.type === b.type) {
      a.children = [...(a.children ?? []), ...(b.children ?? [])]
      children.splice(i + 1, 1)
    } else i++
  }
  const stars = (child: Phrasing | undefined) => !!child && STARS.has(child.type)
  children.forEach((child, i) => {
    if (child.type !== 'emphasis') return
    const touches =
      stars(children[i - 1]) ||
      stars(children[i + 1]) ||
      stars(child.children?.[0]) ||
      stars(child.children?.at(-1)) ||
      (insideStars && (i === 0 || i === children.length - 1))
    if (touches) child.marker = '_'
  })
  for (const child of children) tidyAttention(child, STARS.has(child.type))
}

/** The whole tree, tidied (see `tidyAttention`), then written as remark would. */
export function tidyRoot(fallback: Handler) {
  return (node: Root, parent: Parents | undefined, state: State, info: Info): string => {
    tidyAttention(node as unknown as Phrasing)
    return fallback(node, parent, state, info)
  }
}

/**
 * List items with the author's indentation for what belongs to an item (nested lists, further paragraphs):
 * Obsidian indents with a tab or four spaces, remark with the width of the marker. Task list boxes as in GFM.
 */
export function indentedListItem(unit: string | null) {
  return (node: ListItem, parent: Parents | undefined, state: State, info: Info): string => {
    let bullet = state.bulletCurrent || state.options.bullet || '*'
    if (parent?.type === 'list' && parent.ordered) {
      const start = typeof parent.start === 'number' && parent.start > -1 ? parent.start : 1
      bullet = start + (state.options.incrementListMarker === false ? 0 : parent.children.indexOf(node)) + (state.bulletCurrent || state.options.bulletOrdered || '.')
    }
    const size = bullet.length + 1
    const width = unit === '\t' ? 4 : unit ? unit.length : 0
    const indent = unit && width >= size ? unit : ' '.repeat(size)
    // An empty first paragraph cannot be written: `-`, a blank line and indented text end the item, and the text
    // becomes code. Empty paragraphs at the start of an item are left out, like empty paragraphs anywhere.
    const empty = (child: ListItem['children'][number]) =>
      child.type === 'paragraph' && (child.children ?? []).every((inner) => inner.type === 'text' && !inner.value.trim())
    let skip = 0
    while (skip < node.children.length - 1 && empty(node.children[skip])) skip++
    if (skip) node = { ...node, children: node.children.slice(skip) }
    const head = node.children[0]
    const checkable = typeof node.checked === 'boolean' && head?.type === 'paragraph'
    const checkbox = checkable ? `[${node.checked ? 'x' : ' '}] ` : ''
    const tracker = state.createTracker(info)
    tracker.move(bullet + ' ' + checkbox)
    tracker.shift(size)
    const exit = state.enter('listItem')
    const value = state.indentLines(state.containerFlow(node, tracker.current()), (line, index, blank) => {
      if (index) return (blank ? '' : indent) + line
      return blank ? bullet : bullet + ' ' + checkbox + line
    })
    exit()
    return value
  }
}

/**
 * Top-level blocks to keep as raw Markdown although the editor has nodes for them, by text being parsed and the
 * offset where the block starts: blocks the editor would lose something of (see `lossyBlocks` in editor.ts).
 */
export const forcedRaw = new Map<string, Set<number>>()

/** A code block as it was written: with the author's fence character, or indented where it was indented. */
export function writtenCode(fallback: NonNullable<ToMarkdownOptions['handlers']>['code']) {
  return (node: CodeNode, parent: Parents | undefined, state: State, info: Info): string => {
    const fence = (node.data as { nxFence?: string } | undefined)?.nxFence
    const saved = { fence: state.options.fence, fences: state.options.fences }
    if (fence === '`' || fence === '~') {
      state.options.fence = fence
      state.options.fences = true
    } else if (fence === 'indent') state.options.fences = false
    try {
      return fallback!(node, parent, state, info)
    } finally {
      state.options.fence = saved.fence
      state.options.fences = saved.fences
    }
  }
}

/** Letters and digits of a text with how often each occurs; character references (`&nbsp;`) left out. */
export function letters(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const char of text.replace(/&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/gi, ' ').matchAll(/[\p{L}\p{N}]/gu)) {
    counts.set(char[0], (counts.get(char[0]) ?? 0) + 1)
  }
  return counts
}

/** Does `after` still have every letter and digit of `before`? */
export function keepsLetters(before: string, after: string): boolean {
  const have = letters(after)
  for (const [char, count] of letters(before)) if ((have.get(char) ?? 0) < count) return false
  return true
}

/**
 * After parsing: what the editor has no node for becomes raw Markdown with its exact source. `file.value` is the
 * text being parsed, so the source is cut out by the positions remark gives every node.
 */
export function keepRaw() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value)
    const forced = forcedRaw.get(source)
    if (forced) {
      tree.children = tree.children.map((node) => {
        const start = node.position?.start.offset
        const end = node.position?.end.offset
        return start !== undefined && end !== undefined && forced.has(start)
          ? ({ type: 'nxRawBlock', value: source.slice(start, end), position: node.position } as never)
          : node
      })
    }
    visit(tree, (node, index, parent) => {
      if (!parent || index === undefined) return
      if (node.type === 'link' && node.position?.start.offset !== undefined) {
        const first = source.charAt(node.position.start.offset)
        const form: LinkForm = first === '<' ? 'angle' : first === '[' ? '' : 'bare'
        node.data = { ...node.data, nxForm: form } as never
        return
      }
      if (node.type === 'list' && node.position?.start.offset !== undefined) {
        const head = /^[ \t]*(?:([-*+])|\d{1,9}([.)]))/.exec(source.slice(node.position.start.offset, node.position.start.offset + 16))
        if (head) node.data = { ...node.data, nxMarker: head[1] ?? head[2] } as never
        return
      }
      if (node.type === 'code' && node.position?.start.offset !== undefined) {
        const first = source.slice(node.position.start.offset).replace(/^ {0,3}/, '').charAt(0)
        node.data = { ...node.data, nxFence: first === '`' || first === '~' ? first : 'indent' } as never
        return
      }
      const kind = node.type === 'definition' ? 'nxRawBlock' : node.type === 'linkReference' || node.type === 'imageReference' ? 'nxRawInline' : null
      if (!kind || node.position?.start.offset === undefined || node.position.end.offset === undefined) return
      const value = source.slice(node.position.start.offset, node.position.end.offset)
      parent.children.splice(index, 1, { type: kind, value } as never)
      return index + 1
    })
  }
}
