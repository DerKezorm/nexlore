/** Quick switcher on Ctrl+K: titles first, then text. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useStore } from '../state/store'
import { Symbol } from './Symbol'

export function SearchDialog({ onClose, onPick }: { onClose: () => void; onPick: (id: string) => void }) {
  const { t } = useTranslation()
  const { vault } = useStore()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => input.current?.focus(), [])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = [...vault.notes.values()]
    if (!q) return all.filter((n) => !n.path.includes('Tagesnotizen')).slice(0, 8)
    const byTitle = all.filter((n) => n.title.toLowerCase().includes(q))
    const byText = all.filter((n) => !byTitle.includes(n) && n.body.toLowerCase().includes(q))
    return [...byTitle, ...byText].slice(0, 10)
  }, [query, vault])

  const pick = (id: string) => {
    onPick(id)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-scrim/70 px-4 pt-[12vh]" onMouseDown={onClose}>
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-ink-700 px-4">
          <Symbol name="search" className="h-4 w-4 text-mist-500" />
          <input
            ref={input}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setIndex(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              if (e.key === 'ArrowDown') setIndex((i) => Math.min(results.length - 1, i + 1))
              if (e.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1))
              if (e.key === 'Enter' && results[index]) pick(results[index].id)
            }}
            placeholder={t('search.placeholder')}
            className="h-12 flex-1 bg-transparent text-[15px] text-mist-100 outline-none placeholder:text-mist-600"
          />
          <kbd className="rounded border border-ink-700 px-1.5 text-[11px] text-mist-500">Esc</kbd>
        </div>
        <ul className="nn-scroll max-h-[50vh] overflow-y-auto p-2">
          {results.map((note, i) => (
            <li key={note.id}>
              <button
                type="button"
                onMouseEnter={() => setIndex(i)}
                onClick={() => pick(note.id)}
                className={'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left ' + (i === index ? 'bg-accent-500/12 text-mist-100' : 'text-mist-300')}
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: vault.home.get(note.id)!.color }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{note.title}</span>
                  <span className="block truncate text-xs text-mist-500">{note.path.join(' › ')}</span>
                </span>
              </button>
            </li>
          ))}
          {results.length === 0 && <li className="px-3 py-6 text-center text-sm text-mist-500">{t('search.nothing')}</li>}
        </ul>
      </div>
    </div>
  )
}
