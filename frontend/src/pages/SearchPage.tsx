/**
 * The search page (Ctrl+Shift+F): every note that fits, best first, each with the lines it was found in. The search
 * is text with operators as in Obsidian (`tag:`, `path:`, `space:`, `file:`, `task:`, `"phrase"`, `-word`,
 * `[property:value]`, `changed:7d`); the filters beside it write into that text, the chips above take a piece out.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router-dom'
import { searchApi, tagsApi, type SearchPage as Page, type TagCount } from '../api/client'
import { Marked } from '../components/Marked'
import { Symbol } from '../components/Symbol'
import { folderColor } from '../graph/palette'
import { operator, pieces, replaced, toggled, without } from '../lib/searchText'
import { folderOf, noteUrl } from '../lib/vault'
import { useStore } from '../state/store'

const CHANGED = [
  { value: null, key: 'any' },
  { value: 'changed:7d', key: 'week' },
  { value: 'changed:30d', key: 'month' },
] as const

export function SearchPage() {
  const { t } = useTranslation()
  const { spaces, favorites, setFavorite } = useStore()
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''
  const [typed, setTyped] = useState(query)
  const [page, setPage] = useState<Page | null>(null)
  const [busy, setBusy] = useState(false)
  const [tags, setTags] = useState<TagCount[]>([])
  const [help, setHelp] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => setTyped(query), [query])
  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    tagsApi.list().then((list) => setTags(list.slice(0, 12)), () => setTags([]))
  }, [])
  useEffect(() => {
    let live = true
    if (!query.trim()) {
      setPage(null)
      return
    }
    setBusy(true)
    searchApi.notes(query).then(
      (found) => {
        if (!live) return
        setPage(found)
        setBusy(false)
      },
      () => {
        if (!live) return
        setPage({ notes: [], more: false, ms: 0 })
        setBusy(false)
      },
    )
    return () => {
      live = false
    }
  }, [query])

  const search = (next: string) => setParams(next.trim() ? { q: next.trim() } : {}, { replace: false })
  const more = async () => {
    if (!page) return
    const next = await searchApi.notes(query, page.notes.length)
    setPage({ ...next, notes: [...page.notes, ...next.notes] })
  }
  const list = pieces(query)
  const has = (piece: string) => list.includes(piece)
  const changed = CHANGED.find((option) => option.value && has(option.value))?.value ?? null

  return (
    <main className="nn-scroll flex-1 overflow-y-auto" data-testid="search-page">
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-6 sm:px-6 md:grid-cols-[13rem_1fr]">
        <aside className="order-2 space-y-5 text-sm md:order-1" aria-label={t('searchPage.filters')}>
          <fieldset>
            <legend className="mb-1 text-[11px] font-semibold tracking-wider text-mist-600 uppercase">{t('searchPage.spaces')}</legend>
            {spaces.map((space) => {
              const piece = operator('space', space.name)
              return (
                <label key={space.id} className="flex items-center gap-2 py-0.5 text-mist-300">
                  <input type="checkbox" checked={has(piece)} onChange={() => search(toggled(query, piece))} className="accent-accent-500" />
                  <span className="truncate">{space.name}</span>
                </label>
              )
            })}
          </fieldset>
          <fieldset>
            <legend className="mb-1 text-[11px] font-semibold tracking-wider text-mist-600 uppercase">{t('searchPage.changed')}</legend>
            {CHANGED.map((option) => (
              <label key={option.key} className="flex items-center gap-2 py-0.5 text-mist-300">
                <input type="radio" name="changed" checked={changed === option.value} onChange={() => search(replaced(query, 'changed:', option.value))} className="accent-accent-500" />
                {t(`searchPage.when.${option.key}`)}
              </label>
            ))}
          </fieldset>
          {tags.length > 0 && (
            <fieldset>
              <legend className="mb-1 text-[11px] font-semibold tracking-wider text-mist-600 uppercase">{t('tags.title')}</legend>
              <div className="flex flex-wrap gap-1">
                {tags.map((tag) => {
                  const piece = operator('tag', tag.tag)
                  return (
                    <button key={tag.tag} type="button" aria-pressed={has(piece)} onClick={() => search(toggled(query, piece))} className={'rounded-full border px-2 py-0.5 text-xs ' + (has(piece) ? 'border-accent-500 text-accent-300' : 'border-ink-700 text-mist-400 hover:text-mist-100')}>
                      #{tag.tag}
                    </button>
                  )
                })}
              </div>
            </fieldset>
          )}
          <fieldset>
            <legend className="mb-1 text-[11px] font-semibold tracking-wider text-mist-600 uppercase">{t('searchPage.only')}</legend>
            <label className="flex items-center gap-2 py-0.5 text-mist-300">
              <input type="checkbox" checked={has('task:')} onChange={() => search(toggled(query, 'task:'))} className="accent-accent-500" />
              {t('searchPage.tasks')}
            </label>
          </fieldset>
        </aside>

        <section className="order-1 min-w-0 space-y-4 md:order-2">
          <form
            role="search"
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              search(typed)
            }}
          >
            <div className="flex flex-1 items-center gap-2 rounded-xl border border-ink-700 bg-ink-900 px-3 focus-within:border-accent-500">
              <Symbol name="search" className="h-4 w-4 text-mist-500" />
              <input ref={input} type="search" value={typed} onChange={(event) => setTyped(event.target.value)} aria-label={t('searchPage.label')} placeholder={t('searchPage.placeholder')} className="h-11 flex-1 bg-transparent text-[15px] text-mist-100 outline-none placeholder:text-mist-600" />
            </div>
            {query && (() => {
              const kept = '?' + query.split(/\s+/).filter(Boolean).join(' ')
              const on = favorites.some((favorite) => favorite.path === kept)
              return (
                <button
                  type="button"
                  onClick={() => void setFavorite(kept, !on)}
                  aria-pressed={on}
                  aria-label={t(on ? 'favorites.forgetSearch' : 'favorites.keepSearch')}
                  title={t(on ? 'favorites.forgetSearch' : 'favorites.keepSearch')}
                  data-testid="search-favorite"
                  className={'grid h-11 w-11 place-items-center rounded-xl border border-ink-700 hover:text-mist-100 ' + (on ? 'text-warn-400' : 'text-mist-400')}
                >
                  <Symbol name="star" className="h-4 w-4" />
                </button>
              )
            })()}
            <button type="button" onClick={() => setHelp(!help)} aria-expanded={help} aria-label={t('searchPage.help')} title={t('searchPage.help')} className="h-11 w-11 rounded-xl border border-ink-700 text-mist-400 hover:text-mist-100">?</button>
          </form>
          {list.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {list.map((piece, index) => (
                <button key={piece + index} type="button" onClick={() => search(without(query, piece))} className="inline-flex items-center gap-1 rounded-full border border-accent-500/50 bg-accent-500/10 px-2.5 py-0.5 font-mono text-xs text-accent-300" aria-label={t('searchPage.remove', { piece })}>
                  {piece} <Symbol name="close" className="h-3 w-3" />
                </button>
              ))}
              {page && <span className="ml-1 text-xs text-mist-500">{t('searchPage.count', { count: page.notes.length, more: page.more ? '+' : '', ms: page.ms })}</span>}
            </div>
          )}
          {help && (
            <div className="rounded-xl border border-ink-700 bg-ink-850 p-4 text-sm text-mist-400" data-testid="search-help">
              <p className="mb-2 font-semibold text-mist-200">{t('searchPage.helpTitle')}</p>
              <ul className="grid gap-1 sm:grid-cols-2">
                {(['tag', 'path', 'space', 'file', 'task', 'phrase', 'not', 'property', 'changed'] as const).map((key) => (
                  <li key={key}><code className="text-warn-500">{t(`searchPage.ops.${key}.code`)}</code> {t(`searchPage.ops.${key}.text`)}</li>
                ))}
              </ul>
            </div>
          )}
          {!query.trim() ? (
            <p className="text-sm text-mist-500">{t('searchPage.empty')}</p>
          ) : busy && !page ? (
            <p className="text-sm text-mist-500">{t('common.loading')}</p>
          ) : page && page.notes.length === 0 ? (
            <p className="text-sm text-mist-500">{t('searchPage.nothing')}</p>
          ) : (
            <ol className="divide-y divide-ink-700" aria-busy={busy}>
              {page?.notes.map((note) => (
                <li key={note.path} className="py-3">
                  <Link to={noteUrl(note.path)} data-note={note.path} className="flex items-baseline gap-2">
                    <span className="h-2 w-2 shrink-0 translate-y-[-1px] rounded-full" style={{ background: folderColor(note.path) }} />
                    <span className="font-semibold text-mist-100 hover:text-accent-300">{note.title}</span>
                    <span className="truncate text-xs text-mist-600">{folderOf(note.path).replace(/\//g, ' › ')}</span>
                  </Link>
                  {note.lines.length > 0 && (
                    <ul className="mt-1 space-y-0.5 pl-4">
                      {note.lines.map((line) => (
                        <li key={line.line} className="flex gap-3 text-sm text-mist-400">
                          <span className="w-10 shrink-0 text-right font-mono text-[11px] text-mist-600 tabular-nums">{t('searchPage.line', { line: line.line })}</span>
                          <span className="min-w-0 break-words"><Marked text={line.text} /></span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          )}
          {page?.more && (
            <button type="button" onClick={() => void more()} className="rounded-full border border-ink-700 px-4 py-1.5 text-sm text-mist-300 hover:bg-ink-850">{t('searchPage.more')}</button>
          )}
        </section>
      </div>
    </main>
  )
}
