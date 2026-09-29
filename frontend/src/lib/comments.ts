/**
 * Where a comment sits in the note as it is read: the words it was started on, and a little of what stood before and
 * after them, found again in the text of the page. The text may have changed around them since; the words chosen
 * together with the most of their surroundings win, and when the words are gone the thread says so.
 */

export type Anchor = { quote: string; before: string; after: string }

/** How much of the surroundings is kept on each side. */
export const CONTEXT = 40

/** The anchor of `start`..`end` in `text`. */
export function anchorOf(text: string, start: number, end: number): Anchor {
  return {
    quote: text.slice(start, end),
    before: text.slice(Math.max(0, start - CONTEXT), start),
    after: text.slice(end, end + CONTEXT),
  }
}

/** How many characters two strings share at their end (`a` before) or their start. */
function sharedEnd(a: string, b: string): number {
  let count = 0
  while (count < a.length && count < b.length && a[a.length - 1 - count] === b[b.length - 1 - count]) count++
  return count
}
function sharedStart(a: string, b: string): number {
  let count = 0
  while (count < a.length && count < b.length && a[count] === b[count]) count++
  return count
}

/** Where the anchor's words stand in `text` now: the place whose surroundings fit best; null when they are gone. */
export function locate(text: string, anchor: Anchor): { start: number; end: number } | null {
  if (!anchor.quote) return null
  let best: { start: number; score: number } | null = null
  for (let at = text.indexOf(anchor.quote); at >= 0; at = text.indexOf(anchor.quote, at + 1)) {
    const score =
      sharedEnd(text.slice(Math.max(0, at - anchor.before.length), at), anchor.before) +
      sharedStart(text.slice(at + anchor.quote.length, at + anchor.quote.length + anchor.after.length), anchor.after)
    if (!best || score > best.score) best = { start: at, score }
  }
  return best && { start: best.start, end: best.start + anchor.quote.length }
}

/** The text of an element as the reader sees it, and for each character the text node and offset it sits in. */
export function textMap(root: Node): { text: string; nodes: Text[]; starts: number[] } {
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ''
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    nodes.push(node)
    starts.push(text.length)
    text += node.data
  }
  return { text, nodes, starts }
}

/** A DOM range over characters `start`..`end` of the element's text. */
export function rangeOf(map: ReturnType<typeof textMap>, start: number, end: number): Range | null {
  // A start belongs to the node it begins in, an end to the node it closes (so neither lands on an empty edge).
  const find = (offset: number, atEnd: boolean): [Text, number] | null => {
    for (let index = 0; index < map.nodes.length; index++) {
      const begin = map.starts[index]
      const length = map.nodes[index].data.length
      if (atEnd ? offset > begin && offset <= begin + length : offset >= begin && offset < begin + length)
        return [map.nodes[index], offset - begin]
    }
    return null
  }
  const from = find(start, false)
  const to = find(end, true)
  if (!from || !to) return null
  const range = document.createRange()
  range.setStart(from[0], from[1])
  range.setEnd(to[0], to[1])
  return range
}

/** The `@names` in a comment, split so they can be shown apart from the words around them. */
export function withMentions(body: string): { text: string; mention: boolean }[] {
  const parts: { text: string; mention: boolean }[] = []
  let last = 0
  for (const match of body.matchAll(/(?<![\w@])@[\w][\w.-]{0,63}/gu)) {
    if (match.index! > last) parts.push({ text: body.slice(last, match.index), mention: false })
    parts.push({ text: match[0], mention: true })
    last = match.index! + match[0].length
  }
  if (last < body.length) parts.push({ text: body.slice(last), mention: false })
  return parts
}

/** The `@` being typed just before the caret, and what follows it so far; null outside of one. */
export function typingMention(text: string, caret: number): { start: number; words: string } | null {
  const match = /(?<![\w@])@([\w.-]{0,63})$/u.exec(text.slice(0, caret))
  return match ? { start: match.index, words: match[1] } : null
}

// --- Lighting the words in the page (the CSS Highlight API: the page's own elements stay untouched) ---

export const MARKS = 'nx-comment'
export const CURRENT = 'nx-comment-current'

type Highlights = { set: (name: string, value: unknown) => void; delete: (name: string) => void }
export const highlights = (): Highlights | null => {
  const found = (globalThis as unknown as { CSS?: { highlights?: Highlights } }).CSS?.highlights
  return found && typeof (globalThis as { Highlight?: unknown }).Highlight === 'function' ? found : null
}
export const highlight = (ranges: Range[]) => new (globalThis as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight(...ranges)

/** Scroll to a thread's words in the text and light them a moment longer. */
export function revealThread(root: HTMLElement | null, thread: Anchor): boolean {
  if (!root) return false
  const map = textMap(root)
  const place = locate(map.text, thread)
  const range = place && rangeOf(map, place.start, place.end)
  if (!range) return false
  const target = range.startContainer.parentElement
  target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  const store = highlights()
  store?.set(CURRENT, highlight([range]))
  window.setTimeout(() => store?.delete(CURRENT), 2000)
  return true
}
