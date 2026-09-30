/**
 * A top-level block dragged by its grip lands between top-level blocks.
 *
 * Crepe's drop indicator (prosemirror-drop-indicator) chooses among every block boundary by the distance to the ends
 * of each boundary's line. Above a list, the line of the first item starts further right than the list's own, so a
 * pointer over the text was nearer to it: a paragraph dropped between "Third." and the list became part of the first
 * list item (review before 1.0.0, P3.5). Here the drop of a moved top-level block goes to the nearest boundary between
 * top-level blocks, measured by height alone; anything else is left to the indicator.
 */
import { NodeSelection, Plugin, type EditorState } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

/** The position between top-level blocks nearest to `y`, with the blocks' boxes as the page shows them. */
export function nearestTopLevel(view: EditorView, y: number): number {
  const { doc } = view.state
  let best = 0
  let distance = Infinity
  let pos = 0
  for (let index = 0; index <= doc.childCount; index++) {
    const before = index > 0 ? (view.nodeDOM(pos - doc.child(index - 1).nodeSize) as HTMLElement | null) : null
    const after = index < doc.childCount ? (view.nodeDOM(pos) as HTMLElement | null) : null
    const lines = [before?.getBoundingClientRect?.().bottom, after?.getBoundingClientRect?.().top].filter((value): value is number => value !== undefined)
    for (const line of lines) {
      if (Math.abs(y - line) < distance) {
        distance = Math.abs(y - line)
        best = pos
      }
    }
    if (index < doc.childCount) pos += doc.child(index).nodeSize
  }
  return best
}

function movedTopLevel(view: EditorView, state: EditorState): NodeSelection | null {
  const selection = state.selection
  if (!view.dragging?.move || !(selection instanceof NodeSelection) || selection.$from.depth !== 0) return null
  return selection
}

export function topLevelDrop(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        drop: (view, event) => {
          const moved = movedTopLevel(view, view.state)
          if (!moved) return false
          const target = nearestTopLevel(view, event.clientY)
          // Onto itself: nothing to do, as the indicator does it.
          if (target >= moved.from && target <= moved.to) {
            event.preventDefault()
            return true
          }
          const node = moved.node
          const tr = view.state.tr.delete(moved.from, moved.to)
          const at = tr.mapping.map(target)
          tr.insert(at, node).setSelection(NodeSelection.create(tr.doc, at))
          view.dragging = null
          view.focus()
          view.dispatch(tr.setMeta('uiEvent', 'drop').scrollIntoView())
          event.preventDefault()
          return true
        },
      },
    },
  })
}
