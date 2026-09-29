/**
 * Find and replace in the visual editor: the hits of a word in every text block, lit in the text, one of them the
 * current one. The bar above the editor (`components/FindBar.tsx`) asks through `FindControl`.
 *
 * Code blocks are left out: they are drawn by CodeMirror, which shows none of ProseMirror's marks. A hit never
 * spans two blocks, nor a picture or a line break inside a block. Replacing goes through `insertText`, so the words
 * keep the marks of the first letter they replace, and the block layer writes only the blocks that changed. "Replace
 * all" is one transaction, from the back, and one step of undo.
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'

export type Hit = { from: number; to: number }

type FindState = {
  query: string
  caseSensitive: boolean
  hits: Hit[]
  /** Index of the current hit, -1 without one. */
  current: number
  decorations: DecorationSet
}

/** What the bar sees: how many, and which one is current (0-based, -1 without a hit). */
export type FindStatus = { query: string; caseSensitive: boolean; count: number; current: number; capped: boolean }

export type FindControl = {
  /** A new word to look for (empty clears the marks); the current hit is the first at or after the caret. */
  search: (query: string, caseSensitive: boolean) => void
  next: () => void
  previous: () => void
  /** The current hit replaced; the next one becomes current. */
  replace: (text: string) => void
  /** Every hit replaced, as one step of undo; how many were. */
  replaceAll: (text: string) => number
  status: () => FindStatus
  /** The marks go; the current hit becomes the selection, so the caret is where the search stood. */
  close: (select: boolean) => void
}

/** More hits than this are not marked one by one; the bar says "10000+". */
export const MAX_HITS = 10_000

export const findKey = new PluginKey<FindState>('nxFind')

type Meta = { query?: string; caseSensitive?: boolean; current?: number; near?: number }

const EMPTY: FindState = { query: '', caseSensitive: false, hits: [], current: -1, decorations: DecorationSet.empty }

function pattern(query: string, caseSensitive: boolean): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'gu' : 'giu')
}

/** Every hit in the document's text blocks, code blocks left out. */
export function findHits(doc: ProseNode, query: string, caseSensitive: boolean): Hit[] {
  if (!query) return []
  const hits: Hit[] = []
  const re = pattern(query, caseSensitive)
  doc.descendants((node, pos) => {
    if (hits.length >= MAX_HITS) return false
    if (!node.isTextblock) return true
    if (node.type.spec.code) return false
    // The block's text, anything else inline as one character no word contains; where each piece starts.
    let text = ''
    const starts: number[] = []
    node.forEach((child, offset) => {
      starts.push(text.length, pos + 1 + offset)
      text += child.isText ? child.text! : '￼'
    })
    const at = (index: number): number => {
      let found = 0
      for (let i = 0; i < starts.length; i += 2) if (starts[i] <= index) found = i
      return starts[found + 1] + (index - starts[found])
    }
    re.lastIndex = 0
    for (let match = re.exec(text); match; match = re.exec(text)) {
      if (!match[0].length) {
        re.lastIndex++
        continue
      }
      hits.push({ from: at(match.index), to: at(match.index) + match[0].length })
      if (hits.length >= MAX_HITS) break
    }
    return false
  })
  return hits
}

function decorate(doc: ProseNode, hits: Hit[], current: number): DecorationSet {
  if (!hits.length) return DecorationSet.empty
  return DecorationSet.create(
    doc,
    hits.map((hit, index) => Decoration.inline(hit.from, hit.to, { class: index === current ? 'nx-find nx-find-current' : 'nx-find' })),
  )
}

/** The first hit at or after a position, the first of all past the last. */
function nearest(hits: Hit[], position: number): number {
  if (!hits.length) return -1
  const index = hits.findIndex((hit) => hit.from >= position)
  return index < 0 ? 0 : index
}

function build(doc: ProseNode, query: string, caseSensitive: boolean, current: number): FindState {
  const hits = findHits(doc, query, caseSensitive)
  const index = hits.length ? Math.min(Math.max(current, 0), hits.length - 1) : -1
  return { query, caseSensitive, hits, current: index, decorations: decorate(doc, hits, index) }
}

export function findPlugin(): Plugin<FindState> {
  return new Plugin<FindState>({
    key: findKey,
    state: {
      init: () => EMPTY,
      apply: (tr: Transaction, old: FindState, _before: EditorState, after: EditorState): FindState => {
        const meta = tr.getMeta(findKey) as Meta | undefined
        if (meta) {
          const query = meta.query ?? old.query
          const caseSensitive = meta.caseSensitive ?? old.caseSensitive
          if (!query) return EMPTY
          if (meta.near !== undefined) {
            const hits = findHits(after.doc, query, caseSensitive)
            return build(after.doc, query, caseSensitive, nearest(hits, meta.near))
          }
          return build(after.doc, query, caseSensitive, meta.current ?? old.current)
        }
        if (!old.query || !tr.docChanged) return old
        // Typed while searching: found again, the current hit stays where it was as near as it can.
        const was = old.hits[old.current]
        const hits = findHits(after.doc, old.query, old.caseSensitive)
        const index = was ? nearest(hits, tr.mapping.map(was.from)) : hits.length ? 0 : -1
        return { ...old, hits, current: index, decorations: decorate(after.doc, hits, index) }
      },
    },
    props: {
      decorations: (state) => findKey.getState(state)?.decorations,
    },
  })
}

export function findControl(view: EditorView): FindControl {
  const state = () => findKey.getState(view.state) ?? EMPTY
  const show = () => {
    // The current hit in sight, the focus left where it is (in the bar).
    requestAnimationFrame(() => view.dom.querySelector('.nx-find-current')?.scrollIntoView({ block: 'nearest' }))
  }
  const step = (by: number) => {
    const now = state()
    if (!now.hits.length) return
    const current = (now.current + by + now.hits.length) % now.hits.length
    view.dispatch(view.state.tr.setMeta(findKey, { current } satisfies Meta))
    show()
  }
  return {
    search: (query, caseSensitive) => {
      view.dispatch(view.state.tr.setMeta(findKey, { query, caseSensitive, near: view.state.selection.from } satisfies Meta))
      show()
    },
    next: () => step(1),
    previous: () => step(-1),
    replace: (text) => {
      const now = state()
      const hit = now.hits[now.current]
      if (!hit) return
      const tr = view.state.tr.insertText(text, hit.from, hit.to)
      // The next hit is the one after what was put in.
      tr.setMeta(findKey, { near: tr.mapping.map(hit.to) } satisfies Meta)
      view.dispatch(tr)
      show()
    },
    replaceAll: (text) => {
      const { hits } = state()
      if (!hits.length) return 0
      const tr = view.state.tr
      for (let index = hits.length - 1; index >= 0; index--) tr.insertText(text, hits[index].from, hits[index].to)
      tr.setMeta(findKey, { near: 0 } satisfies Meta)
      view.dispatch(tr)
      return hits.length
    },
    status: () => {
      const now = state()
      return { query: now.query, caseSensitive: now.caseSensitive, count: now.hits.length, current: now.current, capped: now.hits.length >= MAX_HITS }
    },
    close: (select) => {
      const now = state()
      const hit = now.hits[now.current]
      const tr = view.state.tr.setMeta(findKey, { query: '' } satisfies Meta)
      if (select && hit) tr.setSelection(TextSelection.create(tr.doc, hit.from, hit.to)).scrollIntoView()
      view.dispatch(tr)
    },
  }
}
