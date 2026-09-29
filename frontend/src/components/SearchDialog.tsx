/**
 * Quick switcher on Ctrl+K: notes by title, file name or alias first (the server's `/api/notes/find`, the ones changed
 * last while nothing is typed), then the server's full-text search with the matching words marked. The server marks
 * hits with two control characters; they are split here and shown as <mark>, never inserted as HTML.
 *
 * As in Obsidian: when no title is what was typed, the last row makes that note (Shift+Enter makes it right away);
 * `#` at the start lists the headings of the note in front.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, recentApi, vaultApi, type Found, type Hit } from '../api/client'
import { folderColor } from '../graph/palette'
import { errorText } from '../lib/errors'
import { headingsOf } from '../lib/outline'
import { askHeading, shownNote } from '../lib/shell'
import { folderOf } from '../lib/vault'
import { Symbol } from './Symbol'

const HIT_START = '\u0002'
const HIT_END = '\u0003'

type Result =
  | { kind: 'note'; path: string; title: string; snippet?: string; alias?: string | null }
  | { kind: 'create'; path: string; title: string }
  | { kind: 'heading'; path: string; title: string; level: number; index: number }

const fold = (text: string) => text.normalize('NFC').toLocaleLowerCase()
const trail = (folder: string) => folder.replace(/\//g, ' › ')

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

type Props = {
  onClose: () => void
  onPick: (id: string) => void
  /** The folder a new note from here goes to (where the header's "+" would make it); null: none may be made. */
  createIn?: string | null
}

export function SearchDialog({ onClose, onPick, createIn = null }: Props) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const headingMode = query.startsWith('#')
  const [hits, setHits] = useState<Hit[]>([])
  const [titles, setTitles] = useState<Found[]>([])
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => input.current?.focus(), [])

  useEffect(() => {
    const q = query.trim()
    let live = true
    if (headingMode) return
    const timer = window.setTimeout(
      () => {
        const titles = q
          ? vaultApi.find(q, undefined, 8)
          : Promise.all([recentApi.list(8).catch(() => []), vaultApi.find('', undefined, 8)]).then(([opened, changed]) => {
              const seen = new Set(opened.map((note) => note.path))
              return [...opened, ...changed.filter((note) => !seen.has(note.path))].slice(0, 8)
            })
        titles.then((found) => live && setTitles(found)).catch(() => live && setTitles([]))
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
  }, [query, headingMode])

  const results = useMemo<Result[]>(() => {
    if (headingMode) {
      const note = shownNote()
      if (!note) return []
      const words = fold(query.slice(1).trim())
      return headingsOf(note.read())
        .map((heading, index) => ({ kind: 'heading' as const, path: note.path, title: heading.text, level: heading.level, index }))
        .filter((heading) => !words || fold(heading.title).includes(words))
        .slice(0, 50)
    }
    const seen = new Set(titles.map((note) => note.path))
    const found: Result[] = [
      ...titles.map((note) => ({ kind: 'note' as const, path: note.path, title: note.title, alias: note.alias })),
      ...hits.filter((hit) => !seen.has(hit.path)).map((hit) => ({ kind: 'note' as const, path: hit.path, title: hit.title, snippet: hit.snippet })),
    ].slice(0, 20)
    const typed = query.trim()
    // A note of that title is already there (in any readable space): nothing to make.
    if (typed && createIn && !titles.some((note) => fold(note.title) === fold(typed))) found.push({ kind: 'create', path: createIn, title: typed })
    return found
  }, [titles, hits, headingMode, query, createIn])

  const create = async (title: string) => {
    if (!createIn || busy) return
    setBusy(true)
    setProblem(null)
    try {
      const made = await vaultApi.create(createIn, title)
      onPick(made.path)
      onClose()
    } catch (error) {
      setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
      setBusy(false)
    }
  }

  const choose = (result: Result) => {
    if (result.kind === 'create') return void create(result.title)
    onClose()
    if (result.kind === 'heading') askHeading(result.title, result.index)
    else onPick(result.path)
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
              if (e.key === 'Enter' && e.shiftKey && query.trim() && !headingMode) {
                e.preventDefault()
                void create(query.trim())
              } else if (e.key === 'Enter' && results[index]) choose(results[index])
            }}
            placeholder={t('search.placeholder')}
            aria-label={t('search.placeholder')}
            className="h-12 flex-1 bg-transparent text-[15px] text-mist-100 outline-none placeholder:text-mist-600"
          />
          <kbd className="rounded border border-ink-700 px-1.5 text-[11px] text-mist-500">Esc</kbd>
        </div>
        <ul className="nn-scroll max-h-[50vh] overflow-y-auto p-2">
          {results.map((result, i) => (
            <li key={result.kind + ':' + result.path + ':' + (result.kind === 'heading' ? result.index : '')}>
              <button
                type="button"
                onMouseEnter={() => setIndex(i)}
                onClick={() => choose(result)}
                className={'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left ' + (i === index ? 'bg-accent-500/12 text-mist-100' : 'text-mist-300')}
              >
                {result.kind === 'note' ? (
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: folderColor(result.path) }} />
                ) : (
                  <Symbol name={result.kind === 'create' ? 'plus' : 'heading'} className="h-4 w-4 shrink-0 text-accent-400" />
                )}
                <span className="min-w-0 flex-1" style={result.kind === 'heading' ? { paddingLeft: `${(result.level - 1) * 0.75}rem` } : undefined}>
                  <span className="block truncate text-sm font-medium">{result.kind === 'create' ? t('search.create', { title: result.title }) : result.title}</span>
                  <span className="block truncate text-xs text-mist-500">
                    {result.kind === 'create' ? (
                      t('search.createIn', { folder: trail(result.path) })
                    ) : result.kind === 'heading' ? (
                      t('search.heading', { level: result.level })
                    ) : result.snippet ? (
                      <Snippet text={result.snippet} />
                    ) : result.alias ? (
                      t('search.alias', { alias: result.alias, folder: trail(folderOf(result.path)) })
                    ) : (
                      trail(folderOf(result.path))
                    )}
                  </span>
                </span>
                {result.kind === 'create' && <kbd className="hidden shrink-0 rounded border border-ink-700 px-1.5 text-[11px] text-mist-500 sm:inline">Shift ↵</kbd>}
              </button>
            </li>
          ))}
          {results.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-mist-500">
              {headingMode ? (shownNote() ? t('search.noHeadings') : t('search.headingsNeedNote')) : t('search.nothing')}
            </li>
          )}
        </ul>
        {problem && (
          <p role="alert" className="border-t border-ink-700 px-4 py-2 text-sm text-bad-500">
            {problem}
          </p>
        )}
        <p className="hidden border-t border-ink-700 px-4 py-2 text-xs text-mist-600 sm:block">{t('search.hint')}</p>
      </div>
    </div>
  )
}
