/**
 * Suggestions after `[[`: notes whose name contains what was typed, the best first. Arrow keys choose, Enter or
 * Tab takes, Escape closes. The list is a plain element next to the editor, filled by the page. The focus stays in
 * the text; the editor points at the chosen suggestion (`aria-activedescendant`), as a combobox does.
 */
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

export type Suggestion = { label: string; detail: string; insert: string }

type Active = { from: number; to: number; query: string; index: number; items: Suggestion[] } | null

export const suggestKey = new PluginKey<Active>('nxSuggest')

const OPEN = /!?\[\[([^[\]|#\n]*)$/
const LIMIT = 8

function find(state: EditorState, search: (query: string) => Suggestion[]): Active {
  const { selection } = state
  if (!selection.empty) return null
  const $pos = selection.$from
  if (!$pos.parent.isTextblock || $pos.parent.type.spec.code) return null
  const before = $pos.parent.textBetween(0, $pos.parentOffset, undefined, '\ufffc')
  const match = OPEN.exec(before)
  if (!match) return null
  const query = match[1]
  const from = selection.from - query.length
  const items = search(query).slice(0, LIMIT)
  return { from, to: selection.from, query, index: 0, items }
}

function take(view: EditorView, active: NonNullable<Active>, item: Suggestion) {
  const { state } = view
  const after = state.doc.textBetween(active.to, Math.min(active.to + 2, state.selection.$from.end()), undefined, '\ufffc')
  const closing = after === ']]' ? '' : ']]'
  const tr = state.tr.insertText(item.insert + closing, active.from, active.to)
  view.dispatch(tr.setMeta(suggestKey, 'close'))
  view.focus()
}

let instances = 0

export function linkSuggest(options: { search: () => (query: string) => Suggestion[]; label: () => string }) {
  let box: HTMLDivElement | null = null
  let closed: number | null = null // position where Escape closed the list, until the cursor moves elsewhere
  const id = `nx-suggest-${++instances}`

  const render = (view: EditorView, active: Active) => {
    const editable = view.dom
    if (!active || !active.items.length) {
      box?.remove()
      box = null
      editable.setAttribute('aria-expanded', 'false')
      editable.removeAttribute('aria-activedescendant')
      return
    }
    if (!box) {
      box = document.createElement('div')
      box.id = id
      box.className = 'nx-suggest'
      box.setAttribute('role', 'listbox')
      box.setAttribute('aria-label', options.label())
      document.body.appendChild(box)
    }
    editable.setAttribute('aria-expanded', 'true')
    editable.setAttribute('aria-controls', id)
    editable.setAttribute('aria-activedescendant', `${id}-${active.index}`)
    box.replaceChildren(
      ...active.items.map((item, index) => {
        const row = document.createElement('div')
        row.id = `${id}-${index}`
        row.className = 'nx-suggest-item' + (index === active.index ? ' is-active' : '')
        row.setAttribute('role', 'option')
        row.setAttribute('aria-selected', String(index === active.index))
        const name = document.createElement('span')
        name.textContent = item.label
        const detail = document.createElement('span')
        detail.className = 'nx-suggest-detail'
        detail.textContent = item.detail
        row.append(name, detail)
        row.addEventListener('mousedown', (event) => {
          event.preventDefault()
          take(view, active, item)
        })
        return row
      }),
    )
    const coords = view.coordsAtPos(active.from)
    box.style.left = `${Math.max(8, Math.min(coords.left, window.innerWidth - 328))}px`
    box.style.top = `${coords.bottom + 4}px`
  }

  return new Plugin<Active>({
    key: suggestKey,
    state: {
      init: () => null,
      apply: (tr, value, _old, state) => {
        const meta = tr.getMeta(suggestKey)
        if (meta === 'close') return null
        if (typeof meta === 'number' && value) return { ...value, index: meta }
        if (!tr.docChanged && !tr.selectionSet) return value
        const next = find(state, options.search())
        if (next && closed === next.from) return null
        closed = null
        return next
      },
    },
    view: (view) => {
      // Keys are caught before the editor's own keymaps see them (Enter would start a new paragraph).
      const keys = (event: KeyboardEvent) => {
        if (handleKey(view, event)) {
          event.preventDefault()
          event.stopPropagation()
        }
      }
      const host = view.dom.parentElement ?? view.dom
      host.addEventListener('keydown', keys, true)
      view.dom.setAttribute('aria-autocomplete', 'list')
      view.dom.setAttribute('aria-expanded', 'false')
      render(view, suggestKey.getState(view.state) ?? null)
      return {
        update: (v) => render(v, suggestKey.getState(v.state) ?? null),
        destroy: () => {
          host.removeEventListener('keydown', keys, true)
          box?.remove()
          box = null
        },
      }
    },
  })

  function handleKey(view: EditorView, event: KeyboardEvent): boolean {
    const active = suggestKey.getState(view.state)
    if (!active || !active.items.length || event.isComposing) return false
    const count = active.items.length
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const step = event.key === 'ArrowDown' ? 1 : -1
      view.dispatch(view.state.tr.setMeta(suggestKey, (active.index + step + count) % count))
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      take(view, active, active.items[active.index])
      return true
    }
    if (event.key === 'Escape') {
      closed = active.from
      view.dispatch(view.state.tr.setMeta(suggestKey, 'close'))
      return true
    }
    return false
  }
}

/** Search over names: starts-with before contains, shorter first. */
export function searchNames(candidates: Suggestion[], query: string): Suggestion[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return candidates.slice(0, LIMIT)
  const scored: [number, Suggestion][] = []
  for (const item of candidates) {
    const name = item.label.toLocaleLowerCase()
    const at = name.indexOf(needle)
    const inPath = at < 0 ? item.detail.toLocaleLowerCase().indexOf(needle) : -1
    if (at < 0 && inPath < 0) continue
    scored.push([(at === 0 ? 0 : at > 0 ? 1 : 2) * 1000 + Math.min(name.length, 999), item])
  }
  return scored.sort((a, b) => a[0] - b[0]).map(([, item]) => item)
}
