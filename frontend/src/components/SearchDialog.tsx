/**
 * Quick switcher on Ctrl+K: notes by title first (the server's `/api/notes/find`, the ones changed last while nothing
 * is typed), then the server's full-text search with the matching words marked. The server marks hits with two control characters; they are split here and shown as
 * <mark>, never inserted as HTML.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { vaultApi, type Found, type Hit } from '../api/client'
import { folderColor } from '../graph/palette'
import { folderOf } from '../lib/vault'
import { Symbol } from './Symbol'

const HIT_START = '\u0002'
const HIT_END = '\u0003'

type Result = { path: string; title: string; snippet?: string }

function Snippet({ text }: { text: string }) {
  const parts: { text: string; hit: boolean }[] = []
  text.split(HIT_START).forEach((piece, position) => {
    const end = piece.indexOf(HIT_END)
    // Everything before the first start mark is plain text; after a start mark, up to its end mark is the hit.
    if (position === 0 || end < 0) {
      if (piece) parts.push({ text: piece.replaceAll(HIT_END, ''), hit: false })
      return
    }
    parts.push({ text: piece.slice(0, end), hit: true })
    const rest = piece.slice(end + 1).replaceAll(HIT_END, '')
    if (rest) parts.push({ text: rest, hit: false })
  })
  return (
    <>
      {parts.map((part, index) =>
        part.hit ? (
          <mark key={index} className="rounded bg-accent-500/25 px-0.5 text-mist-100">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  )
}

export function SearchDialog({ onClose, onPick }: { onClose: () => void; onPick: (id: string) => void }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [titles, setTitles] = useState<Found[]>([])
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => input.current?.focus(), [])

  useEffect(() => {
    const q = query.trim()
    let live = true
    const timer = window.setTimeout(
      () => {
        vaultApi
          .find(q, undefined, 8)
          .then((found) => live && setTitles(found))
          .catch(() => live && setTitles([]))
        if (!q) return setHits([])
        vaultApi
          .search(q)
          .then((found) => live && setHits(found))
          .catch(() => live && setHits([]))
      },
      q ? 150 : 0,
    )
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [query])

  const results = useMemo<Result[]>(() => {
    const seen = new Set(titles.map((note) => note.path))
    return [
      ...titles.map((note) => ({ path: note.path, title: note.title })),
      ...hits.filter((hit) => !seen.has(hit.path)).map((hit) => ({ path: hit.path, title: hit.title, snippet: hit.snippet })),
    ].slice(0, 20)
  }, [titles, hits])

  const pick = (id: string) => {
    onPick(id)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-scrim/70 px-4 pt-[12vh]" onMouseDown={onClose}>
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 shadow-2xl" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={t('search.button')}>
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
              if (e.key === 'Enter' && results[index]) pick(results[index].path)
            }}
            placeholder={t('search.placeholder')}
            aria-label={t('search.placeholder')}
            className="h-12 flex-1 bg-transparent text-[15px] text-mist-100 outline-none placeholder:text-mist-600"
          />
          <kbd className="rounded border border-ink-700 px-1.5 text-[11px] text-mist-500">Esc</kbd>
        </div>
        <ul className="nn-scroll max-h-[50vh] overflow-y-auto p-2">
          {results.map((result, i) => (
            <li key={result.path}>
              <button
                type="button"
                onMouseEnter={() => setIndex(i)}
                onClick={() => pick(result.path)}
                className={'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left ' + (i === index ? 'bg-accent-500/12 text-mist-100' : 'text-mist-300')}
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: folderColor(result.path) }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{result.title}</span>
                  <span className="block truncate text-xs text-mist-500">
                    {result.snippet ? <Snippet text={result.snippet} /> : folderOf(result.path).replace(/\//g, ' › ')}
                  </span>
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
