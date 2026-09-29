/**
 * The line numbers of the file beside the text (design answer 29.09.2026: the lines of the file, as Obsidian counts
 * them, so that a number matches a text editor or git). Each block, list item and table row shows the line it starts
 * on in the text that would be saved: the block layer's, not the editor's own Markdown.
 *
 * Matching: the saved text is cut into its top-level blocks; each block's round trip is compared with what each
 * top-level node writes on its own. Unchanged blocks meet exactly; a block just typed in meets its neighbours' gap.
 * List items and table rows follow in document order within their block, when their numbers agree.
 *
 * The numbers are a layer of their own beside the editor, not CSS on each block: Crepe positions list items, tables
 * and code blocks itself, and a number hung on them would wander with it.
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { Plugin } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

import type { Block } from './blocks'

export type LineSource = {
  /** The body as it would be saved now. */
  text: () => string
  /** Top-level blocks of Markdown with their offsets, as the editor's parser sees them. */
  blocks: (markdown: string) => Block[]
  /** The editor's round trip of a piece of Markdown. */
  serialize: (markdown: string) => string
  /** What one top-level node writes on its own. */
  write: (node: ProseNode) => string
  /** Where the list items and table rows of a piece start, in document order, as offsets into the piece. */
  parts: (markdown: string) => number[]
}

/** A node (by its position in the document) and the line of the file it starts on. */
export type Numbered = { pos: number; line: number }

const PARTS = new Set(['list_item', 'table_row', 'table_header_row'])
const LOOK_AHEAD = 8
const norm = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim()

/** Line (1 = the first of the body) of every offset of a text, by a table of line starts. */
function lineAt(text: string): (offset: number) => number {
  const starts = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return (offset) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (starts[mid] <= offset) low = mid
      else high = mid - 1
    }
    return low + 1
  }
}

/**
 * The line of every numbered node of `doc` in `text` (the saved body), `first` being the file's line of the body's
 * first line. Pure: the editor passes its own tools, the tests their stand-ins.
 */
export function numberLines(doc: ProseNode, text: string, first: number, source: Omit<LineSource, 'text'>): Numbered[] {
  const line = lineAt(text)
  const blocks = source.blocks(text).filter((block) => text.slice(block.start, block.end).trim())
  const keys = blocks.map((block) => norm(source.serialize(text.slice(block.start, block.end))))
  const nodes: { node: ProseNode; pos: number; key: string }[] = []
  doc.forEach((node, offset) => {
    const key = norm(source.write(node))
    // An empty paragraph writes nothing and has no line of its own.
    if (key) nodes.push({ node, pos: offset, key })
  })
  const out: Numbered[] = []
  const take = (i: number, j: number) => {
    const { node, pos } = nodes[i]
    const block = blocks[j]
    const inside: number[] = []
    node.descendants((child, at) => {
      if (PARTS.has(child.type.name)) inside.push(pos + 1 + at)
    })
    const offsets = inside.length ? source.parts(text.slice(block.start, block.end)) : []
    // A list or table numbers its items or rows (the first stands where the block starts); only if they agree.
    if (inside.length && offsets.length === inside.length) {
      inside.forEach((at, k) => out.push({ pos: at, line: line(block.start + offsets[k]) + first - 1 }))
    } else out.push({ pos, line: line(block.start) + first - 1 })
  }
  let i = 0
  let j = 0
  while (i < nodes.length && j < blocks.length) {
    if (nodes[i].key === keys[j]) {
      take(i, j)
      i++
      j++
      continue
    }
    // A block the saved text has more of (or the editor more of) a few steps on: skip to it.
    let skip = 0
    for (let d = 1; d <= LOOK_AHEAD && !skip; d++) if (keys[j + d] === nodes[i].key) skip = d
    if (skip) {
      j += skip
      continue
    }
    let back = 0
    for (let d = 1; d <= LOOK_AHEAD && !back; d++) if (nodes[i + d]?.key === keys[j]) back = d
    if (back) {
      i += back
      continue
    }
    // Neither found near: the block that was just changed, in its place.
    take(i, j)
    i++
    j++
  }
  return out
}

/**
 * The baseline of a block's first line: from its first letter, the same for a heading, a list item and a table row
 * (whose room is in its cells). A letter's box is the font's ascent and descent; the baseline lies at about
 * `BASELINE` of it for the sans and the mono alike. A block without text: near the top of its own box.
 */
const BASELINE = 0.79

function baseline(element: HTMLElement): number | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  })
  const text = walker.nextNode()
  if (text) {
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 1)
    const box = range.getBoundingClientRect()
    if (box.height) return box.top + box.height * BASELINE
  }
  const box = element.getBoundingClientRect()
  return box.height ? box.top + Math.min(box.height, 24) * BASELINE : null
}

/** Switched on and off from outside; `first` is the file's line of the body's first line (after the front matter). */
export type LineControl = { set: (first: number | null) => void }

export function lineNumbers(source: LineSource, control: LineControl): Plugin {
  return new Plugin({
    view: (view) => {
      let first: number | null = null
      let timer = 0
      let numbered: Numbered[] = []
      const layer = document.createElement('div')
      layer.className = 'nx-lines'
      layer.setAttribute('aria-hidden', 'true')
      layer.dataset.testid = 'line-numbers'

      const place = () => {
        const host = view.dom.parentElement
        if (!host || first === null) return
        if (layer.parentElement !== host) host.appendChild(layer)
        const base = host.getBoundingClientRect()
        const editor = view.dom.getBoundingClientRect()
        const textLeft = editor.left + parseFloat(getComputedStyle(view.dom).paddingLeft || '0') - base.left
        const make = (text: string) => {
          const number = document.createElement('span')
          number.className = 'nx-line'
          number.textContent = text
          return number
        }
        // A number's own baseline, measured once (the font decides); then every read before any write.
        const probe = make('0')
        layer.replaceChildren(probe)
        const own = probe.getBoundingClientRect().height * BASELINE
        const spots = numbered.flatMap(({ pos, line }) => {
          const element = view.nodeDOM(pos)
          const at = element instanceof HTMLElement ? baseline(element) : null
          return at === null ? [] : [{ line, top: at - base.top - own }]
        })
        layer.replaceChildren(
          ...spots.map(({ line, top }) => {
            const number = make(String(line))
            number.style.left = `${textLeft - 44}px`
            number.style.top = `${top}px`
            return number
          }),
        )
      }
      const count = () => {
        timer = 0
        if (first === null) return
        numbered = numberLines(view.state.doc, source.text(), first, source)
        place()
      }
      const later = () => {
        if (first === null) return
        window.clearTimeout(timer)
        timer = window.setTimeout(count, 200)
      }
      // Pictures that load, a window that changes width: the lines move, the numbers with them.
      const resized = new ResizeObserver(() => place())
      resized.observe(view.dom)

      control.set = (next) => {
        first = next
        if (next === null) {
          window.clearTimeout(timer)
          layer.remove()
          return
        }
        count()
      }
      return {
        update: (_view: EditorView, previous) => {
          if (!view.state.doc.eq(previous.doc)) later()
        },
        destroy: () => {
          window.clearTimeout(timer)
          resized.disconnect()
          layer.remove()
        },
      }
    },
  })
}
