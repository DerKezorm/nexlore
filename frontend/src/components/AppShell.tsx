import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'

import { ApiError, everydayApi } from '../api/client'
import { errorText } from '../lib/errors'
import { dailySpace, today as isoToday } from '../lib/everyday'
import { isNotePath } from '../lib/files'
import { fileRoute } from '../lib/markdown'
import { NEW_NOTE_EVENT } from '../lib/newNote'
import { askNoteList, narrow, SEARCH_EVENT } from '../lib/shell'
import { PALETTE_EVENT, useCommands, type Command } from '../lib/commands'
import { storedTheme } from '../lib/theme'
import { useAuth } from '../state/auth'
import { refreshNews } from '../lib/news'
import { CommandPalette } from './CommandPalette'
import { LinkPreview } from './LinkPreview'
import { VaultActions } from './VaultActions'
import { folderOf, noteUrl } from '../lib/vault'
import { useStore } from '../state/store'
import { AccountMenu } from './AccountMenu'
import { InstallPrompt } from './InstallPrompt'
import { Logo } from './Logo'
import { NewNoteDialog } from './NewNoteDialog'
import { ScanNotice } from './ScanNotice'
import { SearchDialog } from './SearchDialog'
import { Symbol, type SymbolName } from './Symbol'
import { ThemeSwitcher } from './ThemeSwitcher'

type NavItem = {
  to: string
  label: 'nav.graph' | 'nav.notes' | 'nav.calendar' | 'nav.tasks' | 'nav.files' | 'nav.settings'
  symbol: SymbolName
  end: boolean
  right?: boolean
  /** Below `sm` the item is in the account menu: a phone has room for the four daily places only. */
  wide?: boolean
}

const ITEMS: NavItem[] = [
  { to: '/', label: 'nav.graph', symbol: 'graph', end: true },
  { to: '/note', label: 'nav.notes', symbol: 'note', end: false },
  { to: '/calendar', label: 'nav.calendar', symbol: 'calendar', end: false },
  { to: '/tasks', label: 'nav.tasks', symbol: 'tasks', end: false },
  { to: '/files', label: 'nav.files', symbol: 'files', end: false, wide: true },
  { to: '/settings', label: 'nav.settings', symbol: 'settings', end: false, right: true, wide: true },
]

function navClass(isActive: boolean, right = false, wide = false): string {
  return (
    (right ? 'ml-auto ' : '') +
    (wide ? 'hidden sm:inline-flex ' : 'inline-flex ') +
    'shrink-0 items-center gap-2 rounded-full px-2.5 py-1.5 text-sm font-medium transition-colors sm:px-3.5 ' +
    (isActive ? 'bg-accent-500/15 text-accent-400' : 'text-mist-500 hover:bg-ink-850 hover:text-mist-100')
  )
}

/** Whether a key goes into text being written: there Alt+T may type a character (Option+T on a Mac). */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

/** Shell like the other nex apps: header with pills, then the page fills the rest of the window. */
export function AppShell() {
  const { t } = useTranslation()
  const [searching, setSearching] = useState(false)
  const [commanding, setCommanding] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  useEffect(() => {
    const ask = () => setSearching(true)
    const palette = () => setCommanding(true)
    window.addEventListener(SEARCH_EVENT, ask)
    window.addEventListener(PALETTE_EVENT, palette)
    return () => {
      window.removeEventListener(SEARCH_EVENT, ask)
      window.removeEventListener(PALETTE_EVENT, palette)
    }
  }, [])

  const { status, error, spaces, reload } = useStore()
  const [creating, setCreating] = useState<string | null>(null)
  const newNoteAt = useRef<string | null>(null)
  const [todayProblem, setTodayProblem] = useState<string | null>(null)
  const home = dailySpace(spaces)

  const openToday = useCallback(async () => {
    setTodayProblem(null)
    // Before the spaces are loaded there is nothing to say yet, and "no space to write in" would be wrong.
    if (status !== 'ready') return
    if (!home) {
      setTodayProblem(t('today.none'))
      return
    }
    try {
      const made = await everydayApi.daily(home.name, isoToday())
      if (made.created) void reload()
      navigate(noteUrl(made.path) + (made.created ? '?edit=1' : ''))
    } catch (problem) {
      setTodayProblem(errorText(problem instanceof ApiError ? problem.code : 'internal_error'))
    }
  }, [home, navigate, reload, status, t])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        // The search page, as Obsidian's "search in all files".
        e.preventDefault()
        setSearching(false)
        navigate('/search')
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearching(true)
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'p') {
        // Instead of printing, as in Obsidian.
        e.preventDefault()
        setSearching(false)
        setCommanding(true)
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyT' && !typing(e.target)) {
        e.preventDefault()
        void openToday()
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyN' && !typing(e.target)) {
        e.preventDefault()
        if (newNoteAt.current) setCreating(newNoteAt.current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openToday, navigate])

  useEffect(() => {
    const ask = (event: Event) => setCreating((event as CustomEvent<string>).detail)
    window.addEventListener(NEW_NOTE_EVENT, ask)
    return () => window.removeEventListener(NEW_NOTE_EVENT, ask)
  }, [])

  // The folder a new note from the header (or Alt+N) goes to: the open note's, else the space last chosen for the
  // daily note. The sidebar has a + of its own beside each folder.
  const newNoteFolder = (): string | null => {
    if (location.pathname.startsWith('/note/')) {
      const path = location.pathname.slice('/note/'.length).split('/').map(decodeURIComponent).join('/')
      const role = spaces.find((space) => space.name === path.split('/')[0])?.role
      if (role === 'write' || role === 'manage') return folderOf(path)
    }
    return home?.name ?? null
  }
  const newNoteTarget = newNoteFolder()
  newNoteAt.current = newNoteTarget

  const { setAppearance } = useAuth()
  const { generation } = useStore()
  useEffect(() => {
    void refreshNews()
    const every = window.setInterval(() => void refreshNews(), 60_000)
    return () => window.clearInterval(every)
  }, [generation])
  // The palette's commands that hold everywhere: the places, and what the header does.
  useCommands((): Command[] => {
    const group = t('palette.app')
    const go = (id: string, label: string, to: string, symbol: Command['symbol']) => ({ id, label, group, symbol, run: () => navigate(to) })
    const list: Command[] = [
      { id: 'app.search', label: t('search.button'), group, symbol: 'search', keys: t('search.shortcut'), run: () => setSearching(true) },
      ...(home ? [{ id: 'app.today', label: t('today.title'), group, symbol: 'today' as const, keys: 'Alt+T', run: () => void openToday() }] : []),
      ...(newNoteAt.current ? [{ id: 'app.newNote', label: t('sidebar.newNote'), group, symbol: 'plus' as const, keys: 'Alt+N', run: () => setCreating(newNoteAt.current) }] : []),
      { id: 'go.search', label: t('searchPage.open'), group, symbol: 'search', keys: 'Ctrl Shift F', run: () => navigate('/search') },
      go('go.graph', t('palette.goTo', { place: t('nav.graph') }), '/', 'graph'),
      go('go.notes', t('palette.goTo', { place: t('nav.notes') }), '/note', 'note'),
      go('go.calendar', t('palette.goTo', { place: t('nav.calendar') }), '/calendar', 'calendar'),
      go('go.tasks', t('palette.goTo', { place: t('nav.tasks') }), '/tasks', 'tasks'),
      go('go.files', t('palette.goTo', { place: t('nav.files') }), '/files', 'files'),
      go('go.settings', t('palette.goTo', { place: t('nav.settings') }), '/settings', 'settings'),
      go('go.account', t('palette.goTo', { place: t('account.page') }), '/account', 'users'),
      {
        id: 'app.theme',
        label: storedTheme() === 'light' ? t('palette.dark') : t('palette.light'),
        group,
        symbol: 'eye',
        run: () => void setAppearance({ mode: storedTheme() === 'light' ? 'dark' : 'light' }).catch(() => {}),
      },
    ]
    if (narrow()) list.push({ id: 'app.noteList', label: t('noteStart.list'), group, symbol: 'sidebar', run: askNoteList })
    return list
  })

  const pick = (id: string) => {
    // A PDF found by its text has a page of its own; it is not in the graph.
    if (!isNotePath(id)) navigate(fileRoute(id))
    else if (location.pathname === '/') navigate(`/?focus=${encodeURIComponent(id)}`)
    else navigate(noteUrl(id))
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="z-20 shrink-0 border-b border-ink-700/80 bg-ink-950/80 backdrop-blur-xl">
        <div className="flex items-center gap-2 px-3 py-2.5 sm:gap-4 sm:px-4">
          <NavLink to="/" className="hidden shrink-0 sm:block" aria-label={t('app.home')}>
            <Logo withWordmark />
          </NavLink>
          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label={t('app.mainMenu')}>
            {ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                aria-label={t(item.label)}
                title={t(item.label)}
                className={({ isActive }) => navClass(isActive, item.right, item.wide)}
                onClick={(event) => {
                  // On a phone "Notes" is the list of notes: it opens as a sheet, on the note page without leaving it.
                  if (item.to !== '/note' || !narrow()) return
                  if (location.pathname === '/note' || location.pathname.startsWith('/note/')) event.preventDefault()
                  askNoteList()
                }}
              >
                <Symbol name={item.symbol} />
                <span className="hidden xl:inline">{t(item.label)}</span>
              </NavLink>
            ))}
          </nav>
          <button
            type="button"
            onClick={() => void openToday()}
            disabled={!home}
            title={home || status !== 'ready' ? t('today.title') : t('today.none')}
            aria-label={t('today.title')}
            className="inline-flex shrink-0 items-center gap-2 rounded-full bg-accent-500 px-3 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-40"
          >
            <Symbol name="today" />
            <span className="hidden sm:inline">{t('today.button')}</span>
          </button>
          <button
            type="button"
            onClick={() => setCreating(newNoteTarget)}
            disabled={!newNoteTarget}
            aria-label={t('sidebar.newNote')}
            title={t('sidebar.newNoteShortcut')}
            className="inline-flex h-8 shrink-0 items-center gap-2 rounded-full border border-accent-500/60 px-2 text-sm font-semibold text-accent-400 hover:bg-accent-500/10 disabled:opacity-40 2xl:px-3"
          >
            <Symbol name="plus" />
            <span className="hidden 2xl:inline">{t('sidebar.newNote')}</span>
          </button>
          <button
            type="button"
            onClick={() => setSearching(true)}
            aria-label={t('search.button')}
            title={`${t('search.button')} (${t('search.shortcut')})`}
            className="inline-flex shrink-0 items-center gap-2 rounded-full border border-ink-700 bg-ink-850 px-2 py-1.5 text-sm text-mist-500 hover:text-mist-100 2xl:pr-2 2xl:pl-3"
          >
            <Symbol name="search" />
            {/* The words from wide screens on; below, the menu's words need the room. */}
            <span className="hidden w-32 text-left 2xl:inline">{t('search.button')}</span>
            <kbd className="hidden rounded border border-ink-700 px-1.5 text-[11px] 2xl:inline">{t('search.shortcut')}</kbd>
          </button>
          <div className="hidden sm:block">
            <ThemeSwitcher />
          </div>
          <AccountMenu />
        </div>
      </header>
      <ScanNotice />
      {todayProblem && (
        <div className="flex shrink-0 items-center gap-2 border-b border-warn-500/30 bg-warn-500/10 px-4 py-2 text-sm text-warn-500" role="status">
          <span className="flex-1">{todayProblem}</span>
          <button type="button" onClick={() => setTodayProblem(null)} aria-label={t('common.close')} className="rounded p-0.5">
            <Symbol name="close" className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {status === 'error' && (
        <div className="shrink-0 border-b border-bad-500/30 bg-bad-500/10 px-4 py-2 text-sm text-bad-500" role="alert">
          {errorText(error ?? 'internal_error')}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <Outlet />
      </div>
      {searching && <SearchDialog onClose={() => setSearching(false)} onPick={pick} createIn={newNoteTarget} />}
      {commanding && <CommandPalette onClose={() => setCommanding(false)} />}
      <LinkPreview />
      <VaultActions />
      {creating && (
        <NewNoteDialog
          folder={creating}
          onClose={() => setCreating(null)}
          onCreated={(path) => {
            setCreating(null)
            void reload()
            navigate(`${noteUrl(path)}?edit=1`)
          }}
        />
      )}
      <InstallPrompt />
    </div>
  )
}
