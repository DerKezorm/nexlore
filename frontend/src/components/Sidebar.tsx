/**
 * Folder tree on the left: spaces, folders, notes, and a new note in the folder one is in.
 *
 * A folder is read from the server when it opens (`/api/folder`), never the whole vault at once, and only the rows
 * in view are drawn: a folder with ten thousand notes scrolls as quickly as one with ten. Spaces and the folders of
 * the active note are open unless closed by hand.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { ApiError, vaultApi, type FolderEntry, type FileEntry } from '../api/client'
import { folderColor, spaceColor } from '../graph/palette'
import { errorText } from '../lib/errors'
import { folderOf, noteUrl } from '../lib/vault'
import { useStore } from '../state/store'
import { Symbol } from './Symbol'

const ROW = 28
/** Files of a folder asked for at a time; more when the list is scrolled to its end. */
const PAGE = 500

type Props = {
  activeNote: string | null
  activeFolder?: string | null
  onNote: (path: string) => void
  onFolder?: (path: string) => void
}

type Listing = { folders: FolderEntry[]; notes: FileEntry[]; loaded: number; total: number; more: boolean }

type Row =
  | { kind: 'folder'; path: string; name: string; depth: number; count: number; color: string; open: boolean; space: boolean }
  | { kind: 'note'; path: string; title: string; depth: number }
  | { kind: 'loading'; path: string; depth: number }
  | { kind: 'more'; path: string; depth: number }

export function Sidebar({ activeNote, activeFolder, onNote, onFolder }: Props) {
  const { t } = useTranslation()
  const { spaces, generation, reload, scan } = useStore()
  const navigate = useNavigate()
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map())
  const [listings, setListings] = useState<Map<string, Listing | 'loading' | 'failed'>>(new Map())
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 600 })

  // Everything read before is stale once the vault changed.
  useEffect(() => setListings(new Map()), [generation])

  const activeChain = useMemo(() => {
    const chain = new Set<string>()
    if (!activeNote) return chain
    const parts = activeNote.split('/')
    for (let i = 1; i < parts.length; i++) chain.add(parts.slice(0, i).join('/'))
    return chain
  }, [activeNote])

  // A note chosen (here, in the graph, by a link) is shown: folders on its way that were closed by hand open again.
  useEffect(() => {
    if (!activeChain.size) return
    setToggled((current) => {
      if (![...activeChain].some((path) => current.get(path) === false)) return current
      const next = new Map(current)
      for (const path of activeChain) if (next.get(path) === false) next.delete(path)
      return next
    })
  }, [activeChain])

  const isOpen = useCallback(
    (path: string) => toggled.get(path) ?? (!path.includes('/') || activeChain.has(path)),
    [toggled, activeChain],
  )

  const load = useCallback((path: string) => {
    setListings((current) => new Map(current).set(path, 'loading'))
    vaultApi
      .folder(path, 0, PAGE)
      .then((listing) =>
        setListings((current) =>
          new Map(current).set(path, {
            folders: listing.folders,
            notes: listing.files.filter((file) => file.is_note),
            loaded: listing.files.length,
            total: listing.total_files,
            more: false,
          }),
        ),
      )
      .catch(() => setListings((current) => new Map(current).set(path, 'failed')))
  }, [])

  // The next page of a long folder, when its end comes into view. Asked once: `more` marks the page on its way.
  const loadMore = useCallback(
    (path: string) => {
      const listing = listings.get(path)
      if (!listing || typeof listing === 'string' || listing.more || listing.loaded >= listing.total) return
      setListings((current) => new Map(current).set(path, { ...listing, more: true }))
      vaultApi
        .folder(path, listing.loaded, PAGE)
        .then((page) =>
          setListings((latest) => {
            const now = latest.get(path)
            if (!now || typeof now === 'string') return latest
            return new Map(latest).set(path, {
              ...now,
              notes: [...now.notes, ...page.files.filter((file) => file.is_note)],
              loaded: now.loaded + page.files.length,
              total: page.total_files,
              more: false,
            })
          }),
        )
        .catch(() => setListings((latest) => new Map(latest).set(path, 'failed')))
    },
    [listings],
  )

  // Every open folder that is not read yet.
  const rows = useMemo(() => {
    const out: Row[] = []
    const wanted: string[] = []
    const walk = (path: string, name: string, depth: number, count: number, color: string, space: boolean) => {
      const open = isOpen(path)
      out.push({ kind: 'folder', path, name, depth, count, color, open, space })
      if (!open) return
      const listing = listings.get(path)
      if (listing === undefined || listing === 'loading') {
        if (listing === undefined) wanted.push(path)
        out.push({ kind: 'loading', path, depth: depth + 1 })
        return
      }
      if (listing === 'failed') return
      for (const folder of listing.folders) walk(folder.path, folder.name, depth + 1, folder.notes, folderColor(folder.path, true), false)
      for (const note of listing.notes) out.push({ kind: 'note', path: note.path, title: note.title || note.name.replace(/\.md$/i, ''), depth: depth + 1 })
      if (listing.loaded < listing.total) out.push({ kind: 'more', path, depth: depth + 1 })
    }
    spaces.forEach((space, index) => walk(space.name, space.name, 0, space.notes, spaceColor(index), true))
    return { out, wanted }
  }, [spaces, listings, isOpen])

  useEffect(() => {
    for (const path of rows.wanted) load(path)
  }, [rows.wanted, load])

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const update = () => setViewport({ top: element.scrollTop, height: element.clientHeight })
    update()
    element.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => {
      element.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [])

  const target = activeNote ? folderOf(activeNote) : activeFolder || spaces[0]?.name

  const toggle = (path: string) => setToggled((current) => new Map(current).set(path, !isOpen(path)))

  const create = async () => {
    if (!title.trim() || !target) return
    try {
      const note = await vaultApi.create(target, title.trim())
      setCreating(false)
      setTitle('')
      setProblem(null)
      await reload()
      navigate(`${noteUrl(note.path)}?edit=1`)
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }

  const first = Math.max(0, Math.floor(viewport.top / ROW) - 10)
  const last = Math.min(rows.out.length, Math.ceil((viewport.top + viewport.height) / ROW) + 10)
  const endsInView = rows.out.slice(first, last).filter((row) => row.kind === 'more').map((row) => row.path).join('\n')
  useEffect(() => {
    for (const path of endsInView.split('\n').filter(Boolean)) loadMore(path)
  }, [endsInView, loadMore])

  const renderRow = (row: Row) => {
    if (row.kind === 'loading' || row.kind === 'more') {
      return <div className="py-1 text-xs text-mist-600" style={{ paddingLeft: row.depth * 12 + 10 }}>{t('common.loading')}</div>
    }
    if (row.kind === 'note') {
      return (
        <button
          type="button"
          onClick={() => onNote(row.path)}
          className={
            'flex h-full w-full items-center gap-2 rounded-lg pr-2 text-left text-[13px] ' +
            (activeNote === row.path ? 'bg-accent-500/15 text-accent-400' : 'text-mist-400 hover:bg-ink-850 hover:text-mist-100')
          }
          style={{ paddingLeft: row.depth * 12 + 10 }}
        >
          <Symbol name="note" className="h-3.5 w-3.5 shrink-0 opacity-60" />
          <span className="truncate">{row.title}</span>
        </button>
      )
    }
    return (
      <div
        className={'group flex h-full items-center gap-1 rounded-lg pr-1.5 ' + (activeFolder === row.path ? 'bg-accent-500/10 text-accent-400' : 'text-mist-300 hover:bg-ink-850')}
        style={{ paddingLeft: row.depth * 12 + 4 }}
      >
        <button type="button" onClick={() => toggle(row.path)} className="rounded p-1 text-mist-600 hover:text-mist-100" aria-label={row.open ? t('sidebar.collapse') : t('sidebar.expand')} aria-expanded={row.open}>
          <Symbol name={row.open ? 'chevronDown' : 'chevronRight'} className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => (onFolder ? onFolder(row.path) : toggle(row.path))}
          className={'flex min-w-0 flex-1 items-center gap-2 text-left ' + (row.space ? 'text-[13px] font-semibold text-mist-100' : 'text-[13px]')}
          title={onFolder ? t('sidebar.flyTo') : undefined}
        >
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: row.color }} />
          <span className="truncate">{row.name}</span>
          <span className="ml-auto shrink-0 text-[11px] text-mist-600 tabular-nums">{row.count}</span>
        </button>
      </div>
    )
  }

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-ink-700/80 bg-ink-950/60 md:flex">
      <div className="px-2 pt-3">
        <div className="mb-2 flex items-center justify-between px-2">
          <span className="text-[11px] font-semibold tracking-wider text-mist-600 uppercase">{t('sidebar.spaces')}</span>
          <button
            type="button"
            onClick={() => setCreating((value) => !value)}
            disabled={!target}
            className="rounded-md p-1 text-mist-500 hover:bg-ink-850 hover:text-mist-100 disabled:opacity-40"
            title={t('sidebar.newNote')}
            aria-label={t('sidebar.newNote')}
          >
            <Symbol name="plus" className="h-4 w-4" />
          </button>
        </div>
        {creating && target && (
          <form
            className="mb-3 px-2"
            onSubmit={(event) => {
              event.preventDefault()
              void create()
            }}
          >
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => event.key === 'Escape' && setCreating(false)}
              placeholder={t('sidebar.newTitle')}
              aria-label={t('sidebar.newTitle')}
              className="h-8 w-full rounded-lg border border-ink-700 bg-ink-850 px-2 text-[13px] outline-none focus:border-accent-500"
            />
            <p className="mt-1 truncate text-[11px] text-mist-600">{t('sidebar.newIn', { folder: target })}</p>
            {problem && <p className="mt-1 text-[11px] text-bad-500">{errorText(problem)}</p>}
          </form>
        )}
      </div>
      <div ref={scroller} className="nn-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3" data-testid="sidebar-tree">
        {spaces.length === 0 && <p className="px-2 text-sm text-mist-500">{scan.running ? t('scan.plain') : t('sidebar.empty')}</p>}
        <ul className="relative" style={{ height: rows.out.length * ROW }}>
          {rows.out.slice(first, last).map((row, i) => (
            <li key={row.kind + ':' + row.path} className="absolute right-0 left-0" style={{ top: (first + i) * ROW, height: ROW }}>
              {renderRow(row)}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  )
}
