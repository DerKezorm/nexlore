/**
 * Folding in the editor, with the reading view's folds (`lib/folds.ts`): an arrow at every heading and every list item
 * with items below it; folded, the blocks up to the next heading as high or higher (or the items below) are hidden by
 * a decoration. The document stays as it is, so saving never sees a fold. A cursor that lands in a folded part (arrow
 * keys, search, a jump) opens that fold.
 */
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'

import { headingKind, itemKind, namer } from '../lib/folds'

/** Where the editor keeps its folds: the note's, in this browser. */
export type FoldStore = {
  keys: () => Set<string>
  toggle: (key: string) => void
  /** Folds all or none, with the folds this document has. */
  set: (keys: string[]) => void
  subscribe: (changed: () => void) => () => void
  /** Labels for the arrow. */
  label: (folded: boolean, name: string) => string
}

type Folded = { from: number; to: number; key: string }
type State = { decorations: DecorationSet; hidden: Folded[]; all: string[] }

export const foldKey = new PluginKey<State>('nx-folds')

/** The first paragraph's words of a list item. */
function itemText(item: ProseNode): string {
  const first = item.firstChild
  return first && !first.type.name.includes('list') ? first.textContent : ''
}

function build(doc: ProseNode, folds: Set<string>, store: FoldStore): State {
  const decorations: Decoration[] = []
  const hidden: Folded[] = []
  const all: string[] = []
  const name = namer()
  const arrow = (pos: number, key: string, label: string) => {
    const folded = folds.has(key)
    decorations.push(
      Decoration.widget(
        pos,
        () => {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'nx-fold'
          button.contentEditable = 'false'
          button.dataset.fold = key
          button.setAttribute('aria-expanded', String(!folded))
          button.setAttribute('aria-label', store.label(folded, label))
          button.addEventListener('mousedown', (event) => event.preventDefault())
          button.addEventListener('click', (event) => {
            event.preventDefault()
            store.toggle(key)
          })
          return button
        },
        { side: -1, key: `fold:${key}:${folded}`, ignoreSelection: true },
      ),
    )
    return folded
  }
  const hide = (from: number, to: number, key: string) => {
    decorations.push(Decoration.node(from, to, { class: 'nx-folded' }))
    hidden.push({ from, to, key })
  }

  // Headings of the note itself (not inside a quote or a list).
  const top: { node: ProseNode; pos: number }[] = []
  doc.forEach((node, pos) => top.push({ node, pos }))
  top.forEach(({ node, pos }, index) => {
    if (node.type.name !== 'heading') return
    const level = Number(node.attrs.level)
    const below = []
    for (const next of top.slice(index + 1)) {
      if (next.node.type.name === 'heading' && Number(next.node.attrs.level) <= level) break
      below.push(next)
    }
    if (!below.length) return
    const key = name(headingKind(level, node.textContent))
    all.push(key)
    if (arrow(pos + 1, key, node.textContent)) for (const next of below) hide(next.pos, next.pos + next.node.nodeSize, key)
  })
  // List items with items below them, at any depth.
  doc.descendants((node, pos) => {
    if (node.type.name !== 'list_item') return true
    const lists: { from: number; to: number }[] = []
    node.forEach((child, offset) => {
      if (child.type.name.includes('list')) lists.push({ from: pos + 1 + offset, to: pos + 1 + offset + child.nodeSize })
    })
    if (!lists.length) return true
    const key = name(itemKind(itemText(node)))
    all.push(key)
    if (arrow(pos + 2, key, itemText(node))) for (const list of lists) hide(list.from, list.to, key)
    return true
  })
  return { decorations: DecorationSet.create(doc, decorations), hidden, all }
}

export function foldPlugin(store: FoldStore): Plugin<State> {
  return new Plugin<State>({
    key: foldKey,
    state: {
      init: (_, state) => build(state.doc, store.keys(), store),
      apply: (tr, old, _, state) => (tr.docChanged || tr.getMeta(foldKey) ? build(state.doc, store.keys(), store) : old),
    },
    props: {
      decorations: (state) => foldKey.getState(state)?.decorations,
      // At the end of a folded block's words (review before 1.0.0, P3.14): Enter on a folded list item makes a new
      // item after it and all it holds, instead of taking the hidden items along; Delete on a folded heading opens
      // the fold first, instead of joining the hidden paragraph to the heading unseen.
      handleKeyDown: (view, event) => {
        if ((event.key !== 'Enter' && event.key !== 'Delete') || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false
        const { state } = view
        const { $from, empty } = state.selection
        if (!empty || $from.depth < 1 || $from.parentOffset !== $from.parent.content.size) return false
        const after = $from.after()
        const hidden = foldKey.getState(state)?.hidden.find((part) => part.from === after)
        if (!hidden) return false
        if (event.key === 'Delete') {
          store.toggle(hidden.key)
          return true
        }
        const item = $from.depth >= 2 ? $from.node(-1) : null
        if (!item || item.type.name !== 'list_item' || $from.index(-1) !== 0) return false
        const attrs = item.attrs.checked === null || item.attrs.checked === undefined ? item.attrs : { ...item.attrs, checked: false }
        const fresh = item.type.createAndFill(attrs)
        if (!fresh) return false
        const end = $from.after(-1)
        const tr = state.tr.insert(end, fresh)
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, end + 2)).scrollIntoView())
        return true
      },
    },
    view: (view: EditorView) => {
      const off = store.subscribe(() => !view.isDestroyed && view.dispatch(view.state.tr.setMeta(foldKey, true)))
      return {
        update: (current: EditorView) => {
          // The cursor in a folded part: that part opens (it would be typed into unseen).
          const at = current.state.selection.from
          const inside = foldKey.getState(current.state)?.hidden.find((part) => at > part.from && at < part.to)
          if (inside) store.toggle(inside.key)
        },
        destroy: off,
      }
    },
  })
}

/** Every fold the document has, for "fold all". */
export function allFolds(state: EditorState): string[] {
  return foldKey.getState(state)?.all ?? []
}
