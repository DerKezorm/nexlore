/**
 * Dates in words after "@": "@morgen", "@nächsten Freitag", "@in 3 Tagen", "@tomorrow" offer the day they mean
 * (`lib/dates`). Enter or Tab writes a link to that day's daily note (`[[2026-10-01]]`, as daily notes are named),
 * Shift+Enter the date alone; Escape closes. Only after a space or at the start of a line, so an address like
 * `name@example.com` never asks; never in code.
 */
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

import { dateWords, isoDate, type DateWord } from '../lib/dates'

type Active = { from: number; to: number; query: string; index: number; items: DateWord[] } | null

export const dateKey = new PluginKey<Active>('nxDates')

const OPEN = /(?:^|\s)@([^\s@][^@\n]{0,24})$/

export type DateLabels = { list: string; hint: string; locale: () => string }

function find(state: EditorState, today: () => Date): Active {
  const { selection } = state
  if (!selection.empty) return null
  const $pos = selection.$from
  if (!$pos.parent.isTextblock || $pos.parent.type.spec.code) return null
  const before = $pos.parent.textBetween(0, $pos.parentOffset, undefined, '￼')
  const match = OPEN.exec(before)
  if (!match) return null
  const items = dateWords(match[1], today())
  if (!items.length) return null
  return { from: selection.from - match[1].length - 1, to: selection.from, query: match[1], index: 0, items }
}

let instances = 0

export function dateSuggest(labels: () => DateLabels, today: () => Date = () => new Date()) {
  let box: HTMLDivElement | null = null
  let closed: number | null = null
  const id = `nx-dates-${++instances}`

  const take = (view: EditorView, active: NonNullable<Active>, item: DateWord, plain: boolean) => {
    const day = isoDate(item.date)
    view.dispatch(view.state.tr.insertText(plain ? day : `[[${day}]]`, active.from, active.to).setMeta(dateKey, 'close'))
    view.focus()
  }

  const render = (view: EditorView, active: Active) => {
    if (!active) {
      box?.remove()
      box = null
      return
    }
    const words = labels()
    if (!box) {
      box = document.createElement('div')
      box.id = id
      box.className = 'nx-suggest'
      box.setAttribute('role', 'listbox')
      box.setAttribute('data-testid', 'date-suggest')
      document.body.appendChild(box)
    }
    box.setAttribute('aria-label', words.list)
    const format = new Intl.DateTimeFormat(words.locale(), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    const rows = active.items.map((item, index) => {
      const row = document.createElement('div')
      row.id = `${id}-${index}`
      row.className = 'nx-suggest-item' + (index === active.index ? ' is-active' : '')
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(index === active.index))
      const name = document.createElement('span')
      name.textContent = item.phrase
      const detail = document.createElement('span')
      detail.className = 'nx-suggest-detail'
      detail.textContent = format.format(item.date)
      row.append(name, detail)
      row.addEventListener('mousedown', (event) => {
        event.preventDefault()
        take(view, active, item, event.shiftKey)
      })
      return row
    })
    const hint = document.createElement('div')
    hint.className = 'nx-suggest-detail px-2.5 pt-1'
    hint.textContent = words.hint
    box.replaceChildren(...rows, hint)
    const coords = view.coordsAtPos(active.from)
    box.style.left = `${Math.max(8, Math.min(coords.left, window.innerWidth - 328))}px`
    box.style.top = `${coords.bottom + 4}px`
  }

  const handleKey = (view: EditorView, event: KeyboardEvent): boolean => {
    const active = dateKey.getState(view.state)
    if (!active || event.isComposing) return false
    const count = active.items.length
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      view.dispatch(view.state.tr.setMeta(dateKey, (active.index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count))
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      take(view, active, active.items[active.index], event.shiftKey)
      return true
    }
    if (event.key === 'Escape') {
      closed = active.from
      view.dispatch(view.state.tr.setMeta(dateKey, 'close'))
      return true
    }
    return false
  }

  return new Plugin<Active>({
    key: dateKey,
    state: {
      init: () => null,
      apply: (tr, value, _old, state) => {
        const meta = tr.getMeta(dateKey)
        if (meta === 'close') return null
        if (typeof meta === 'number' && value) return { ...value, index: meta }
        if (!tr.docChanged && !tr.selectionSet) return value
        const next = find(state, today)
        if (next && closed === next.from) return null
        closed = null
        return next
      },
    },
    view: (view) => {
      // Before the editor's own keymaps (Enter would start a new paragraph).
      const keys = (event: KeyboardEvent) => {
        if (handleKey(view, event)) {
          event.preventDefault()
          event.stopPropagation()
        }
      }
      const host = view.dom.parentElement ?? view.dom
      host.addEventListener('keydown', keys, true)
      return {
        update: (v) => render(v, dateKey.getState(v.state) ?? null),
        destroy: () => {
          host.removeEventListener('keydown', keys, true)
          box?.remove()
          box = null
        },
      }
    },
  })
}
