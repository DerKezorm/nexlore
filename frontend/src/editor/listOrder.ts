/**
 * The numbers of ordered lists, kept in step as Milkdown's own `syncListOrderPlugin` keeps them, but only after a
 * change to the text. Milkdown's ran over the whole note after every transaction, a moved cursor too, and Crepe sets
 * the selection once for every list item it mounts: a note full of lists took quadratic time to open (120 KB: 35 s,
 * review before 1.0.0, PG-107). A selection alone never changes a number.
 */
import { bulletListSchema, listItemSchema, orderedListSchema } from '@milkdown/kit/preset/commonmark'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'

export const keepListOrder = $prose((ctx) => {
  const sync = (transactions: readonly Transaction[], _old: EditorState, state: EditorState): Transaction | null => {
    if (!transactions.some((tr) => tr.docChanged)) return null
    if (!state.selection || transactions.some((tr) => tr.getMeta('addToHistory') === false || !tr.isGeneric)) return null
    const ordered = orderedListSchema.type(ctx)
    const bullet = bulletListSchema.type(ctx)
    const item = listItemSchema.type(ctx)
    const label = (attrs: Record<string, unknown>, index: number, start = 1) => {
      const wanted = `${index + start}.`
      if (attrs.label === wanted) return false
      attrs.label = wanted
      return true
    }
    let tr = state.tr
    let changed = false
    state.doc.descendants((node, pos, parent, index) => {
      if (node.type === bullet) {
        const first = node.maybeChild(0)
        if (first?.type === item && first.attrs.listType === 'ordered') {
          changed = true
          tr.setNodeMarkup(pos, ordered, { spread: true })
          node.descendants((child, at, _parent, place) => {
            if (child.type === item) {
              const attrs = { ...child.attrs }
              if (label(attrs, place)) tr = tr.setNodeMarkup(at, undefined, attrs)
            }
            return false
          })
        }
      } else if (node.type === item && parent?.type === ordered) {
        const attrs = { ...node.attrs }
        let different = false
        if (attrs.listType !== 'ordered') {
          attrs.listType = 'ordered'
          different = true
        }
        if (parent.maybeChild(0)) different = label(attrs, index, parent.attrs.order ?? 1)
        if (different) {
          tr = tr.setNodeMarkup(pos, undefined, attrs)
          changed = true
        }
      }
    })
    return changed ? tr.setMeta('addToHistory', false) : null
  }
  return new Plugin({ key: new PluginKey('NEXLORE_KEEP_LIST_ORDER'), appendTransaction: sync })
})
