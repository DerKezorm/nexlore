/**
 * Tables with some comfort (Tab to the next cell, the grips to drag rows and columns and the alignment buttons come
 * with Crepe): the alignment of the column the cursor is in, none included, and sorting the rows by it.
 *
 * A table without alignment is written as Obsidian writes it (`---`); Milkdown gave every new or pasted table
 * "left" (`:-`). `alignedCells` takes that default away.
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { TextSelection, type Command, type EditorState } from '@milkdown/kit/prose/state'
import { tableCellSchema, tableHeaderSchema } from '@milkdown/kit/preset/gfm'

export type Alignment = 'left' | 'center' | 'right' | null

type Place = { table: ProseNode; tablePos: number; column: number; row: number }

/** The table the cursor is in, and the cell's column and row. */
export function tablePlace(state: EditorState): Place | null {
  const { $from } = state.selection
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name !== 'table') continue
    const row = $from.index(d)
    const column = $from.depth > d + 1 ? $from.index(d + 1) : 0
    return { table: $from.node(d), tablePos: $from.before(d), column, row }
  }
  return null
}

/** Sets the alignment of the cursor's column in every row (null: none). */
export function alignColumn(alignment: Alignment): Command {
  return (state, dispatch) => {
    const place = tablePlace(state)
    if (!place) return false
    if (dispatch) {
      const tr = state.tr
      let rowPos = place.tablePos + 1
      place.table.forEach((row) => {
        let cellPos = rowPos + 1
        row.forEach((cell, _, index) => {
          if (index === place.column) tr.setNodeMarkup(cellPos, undefined, { ...cell.attrs, alignment })
          cellPos += cell.nodeSize
        })
        rowPos += row.nodeSize
      })
      dispatch(tr)
    }
    return true
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Sorts the rows below the header by the cursor's column; the cursor stays in the header's cell. */
export function sortByColumn(direction: 1 | -1): Command {
  return (state, dispatch) => {
    const place = tablePlace(state)
    if (!place || place.table.childCount < 3) return false
    if (dispatch) {
      const rows: ProseNode[] = []
      place.table.forEach((row) => rows.push(row))
      const [header, ...body] = rows
      const text = (row: ProseNode) => (place.column < row.childCount ? row.child(place.column).textContent.trim() : '')
      const sorted = body
        .map((row, index) => ({ row, index }))
        .sort((a, b) => direction * collator.compare(text(a.row), text(b.row)) || a.index - b.index)
        .map(({ row }) => row)
      const rebuilt = place.table.type.create(place.table.attrs, [header, ...sorted])
      const tr = state.tr.replaceWith(place.tablePos, place.tablePos + place.table.nodeSize, rebuilt)
      // The cursor into the header's cell of the column sorted by.
      let cellStart = place.tablePos + 2
      for (let index = 0; index < place.column; index++) cellStart += header.child(index).nodeSize
      tr.setSelection(TextSelection.near(tr.doc.resolve(cellStart + 1)))
      dispatch(tr)
    }
    return true
  }
}

/** Table cells without an alignment unless one was chosen or pasted. */
function withoutDefault<T extends typeof tableCellSchema | typeof tableHeaderSchema>(schema: T) {
  return schema.extendSchema((previous) => (ctx) => {
    const base = previous(ctx)
    return {
      ...base,
      attrs: { ...base.attrs, alignment: { default: null } },
      parseDOM: (base.parseDOM ?? []).map((rule) => ({
        ...rule,
        getAttrs: (dom: HTMLElement | string) => {
          const attrs = typeof rule.getAttrs === 'function' ? rule.getAttrs(dom as HTMLElement) : {}
          if (attrs && typeof dom !== 'string' && !dom.style.textAlign) return { ...attrs, alignment: null }
          return attrs
        },
      })),
      toDOM: (node: ProseNode) => {
        const out = base.toDOM!(node) as [string, Record<string, string>, number]
        if (!node.attrs.alignment && out[1]?.style) {
          const rest = { ...out[1] }
          delete rest.style
          return [out[0], rest, out[2]] as typeof out
        }
        return out
      },
    }
  })
}

export const alignedCells = [withoutDefault(tableCellSchema), withoutDefault(tableHeaderSchema)].flat()
