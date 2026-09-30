/**
 * Moving a block up or down, as an outliner does: in a list the item the cursor is in moves among its siblings with
 * the items below it; elsewhere the block the cursor is in moves among the blocks of the note. Alt+Up and Alt+Down,
 * and Ctrl+Shift+Up and Down as in Obsidian. The cursor moves along; one step undo takes back. Saving writes only the
 * blocks that changed place (the block layer takes a moved block from the original).
 */
import { Fragment } from '@milkdown/kit/prose/model'
import { keymap } from '@milkdown/kit/prose/keymap'
import { TextSelection, type Command, type Plugin } from '@milkdown/kit/prose/state'

export function moveBlock(direction: -1 | 1): Command {
  return (state, dispatch) => {
    const { $from, $to, from, to } = state.selection
    // The innermost list item holding the whole selection, else the block of the note it lies in.
    let depth = 0
    for (let d = Math.min($from.depth, $to.depth); d > 0; d--) {
      if ($from.node(d).type.name === 'list_item' && $from.before(d) === $to.before(d)) {
        depth = d
        break
      }
    }
    if (!depth) {
      if ($from.depth < 1 || $from.before(1) !== $to.before(1)) return false
      depth = 1
    }
    const parent = $from.node(depth - 1)
    const index = $from.index(depth - 1)
    const other = index + direction
    if (other < 0 || other >= parent.childCount) return false
    if (dispatch) {
      const node = $from.node(depth)
      const neighbour = parent.child(other)
      const start = $from.before(depth)
      const end = $from.after(depth)
      const range = direction < 0 ? { from: start - neighbour.nodeSize, to: end } : { from: start, to: end + neighbour.nodeSize }
      const placed = direction < 0 ? [node, neighbour] : [neighbour, node]
      const moved = direction < 0 ? start - neighbour.nodeSize : start + neighbour.nodeSize
      const tr = state.tr.replaceWith(range.from, range.to, Fragment.from(placed))
      tr.setSelection(TextSelection.create(tr.doc, from - start + moved, to - start + moved))
      dispatch(tr.scrollIntoView())
    }
    return true
  }
}

export function moveBlockKeys(): Plugin {
  return keymap({
    'Alt-ArrowUp': moveBlock(-1),
    'Alt-ArrowDown': moveBlock(1),
    'Mod-Shift-ArrowUp': moveBlock(-1),
    'Mod-Shift-ArrowDown': moveBlock(1),
  })
}
