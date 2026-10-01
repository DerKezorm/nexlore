/**
 * Folder tree on the left: spaces, folders, notes, and a new note in the folder one is in.
 *
 * A folder is read from the server when it opens (`/api/folder`), never the whole vault at once, and only the rows
 * in view are drawn: a folder with ten thousand notes scrolls as quickly as one with ten. Spaces and the folders of
 * the active note are open unless closed by hand. A click on a folder's name opens or closes it, everywhere.
 *
 * The right mouse button (or a long press on a touch screen) opens a menu: a new note or folder, renaming, moving,
 * the graph, the trash. A folder that could not be read says so and offers to try again.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate } from 'react-router-dom'

import { recentApi, spaceZipUrl, vaultApi, type Favorite, type FolderEntry, type FileEntry, type NoteRef } from '../api/client'
import { folderColor, spaceColor } from '../graph/palette'
import { fileRoute } from '../lib/markdown'
import { menuTriggers, useContextMenu, type MenuItem } from '../lib/menu'
import { askNewNote } from '../lib/newNote'
import { askFolder, FOLDER_EVENT, narrow, NOTE_LIST_EVENT, RECENT_EVENT, SIDEBAR_EVENT, sidebarHere, takeFolderWish, noteListWished, forgetNoteListWish } from '../lib/shell'
import { answerNotice, seenAll, useNews } from '../lib/news'
import { openInTab } from '../lib/tabs'
import { baseName, folderOf, noteUrl } from '../lib/vault'
import { askVaultAction, copyText, FORGET_EVENT, reveal, REVEAL_EVENT, within } from '../lib/vaultActions'
import { usePeople } from '../lib/people'
import { useAuth } from '../state/auth'
import { useStore } from '../state/store'
import { lookOf } from '../lib/looks'
import { LookIcon } from './LookIcon'
import { TagTree } from './TagTree'
import { useThemeVersion } from '../lib/theme'
import { Symbol, type SymbolName } from './Symbol'
import { NameDialog } from './NameDialog'

const FAVORITE_SYMBOLS: Record<Favorite['kind'], SymbolName> = { note: 'note', folder: 'folder', file: 'file', heading: 'heading', search: 'search' }

const ROW = 28
/** Notes opened last, at the top of the sidebar. */
const RECENT = 5
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
  | { kind: 'folder'; path: string; name: string; depth: number; count: number; color: string; icon: string | null; open: boolean; space: boolean }
  | { kind: 'note'; path: string; title: string; depth: number }
  | { kind: 'loading'; path: string; depth: number }
  | { kind: 'more'; path: string; depth: number }
  | { kind: 'failed'; path: string; depth: number }
  | { kind: 'empty'; path: string; depth: number }

/** Notes, and views over notes (Obsidian's .base files), are what the tree lists. */
const inTree = (file: { is_note: boolean; path: string }) => file.is_note || /\.base$/i.test(file.path)

/** What a note or folder dragged in the sidebar carries. */
const DRAG_TYPE = 'application/x-nexlore-path'

export function Sidebar({ activeNote, activeFolder, onNote: choose, onFolder }: Props) {
  const { t, i18n } = useTranslation()
  const nameOf = usePeople()
  const news = useNews()
  const [newsOpen, setNewsOpen] = useState(() => {
    try {
      return localStorage.getItem('nexlore.newsOpen') === 'open'
    } catch {
      return false
    }
  })
  const showNews = (open: boolean) => {
    setNewsOpen(open)
    try {
      if (open) localStorage.setItem('nexlore.newsOpen', 'open')
      else localStorage.removeItem('nexlore.newsOpen')
    } catch {
      // Not remembered: closed again next time.
    }
  }
  // On a phone the sidebar is a sheet from the left: the header's "Notes" or the empty note page ask for it.
  const [sheet, setSheet] = useState(() => noteListWished() && narrow())
  // Closed by any way (or never opened here): the wish is done.
  useEffect(() => {
    if (!sheet) forgetNoteListWish()
  }, [sheet])
  useEffect(() => {
    const ask = () => {
      if (narrow()) setSheet(true)
    }
    window.addEventListener(NOTE_LIST_EVENT, ask)
    return () => window.removeEventListener(NOTE_LIST_EVENT, ask)
  }, [])
  useEffect(() => {
    if (!sheet) return
    const key = (event: KeyboardEvent) => event.key === 'Escape' && setSheet(false)
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [sheet])
  // Folded to a strip of symbols (with the account, on every device); Alt+B, the palette or the button in its head.
  const { me, setAppearance } = useAuth()
  // Kept per account: on a shared computer another account never sees these titles, not even for a moment.
  const recentKey = `nexlore.recent.${me?.id ?? 'none'}`
  const rail = me?.appearance?.sidebar === 'rail'
  const setRail = useCallback((next: boolean) => void setAppearance({ sidebar: next ? 'rail' : 'open' }).catch(() => {}), [setAppearance])
  // Two quick presses come before the page has drawn the first: each flips what the one before it meant, not what
  // is on the screen yet (both used to fold).
  const railMeant = useRef(rail)
  useEffect(() => {
    railMeant.current = rail
  }, [rail])
  useEffect(() => {
    const toggle = () => {
      if (narrow()) {
        setSheet((open) => !open)
        return
      }
      railMeant.current = !railMeant.current
      setRail(railMeant.current)
    }
    window.addEventListener(SIDEBAR_EVENT, toggle)
    return () => window.removeEventListener(SIDEBAR_EVENT, toggle)
  }, [setRail])
  // "Recent" and "Favorites" fold alike, each remembered in this browser.
  const [recentOpen, showRecent] = useFold('nexlore.recentOpen')
  const [favoritesOpen, showFavorites] = useFold('nexlore.favoritesOpen')
  // The last list known in this browser stands at once: coming in late, it pushed the tree down under a click.
  const [recent, setRecent] = useState<NoteRef[]>(() => {
    try {
      const kept = JSON.parse(localStorage.getItem(recentKey) ?? '[]')
      return Array.isArray(kept) ? kept.filter((item) => typeof item?.path === 'string' && typeof item?.title === 'string').slice(0, RECENT) : []
    } catch {
      return []
    }
  })
  // Read again once the note page has told the server a note was opened: the one just opened comes first.
  useEffect(() => {
    let live = true
    const keep = (list: NoteRef[]) => {
      if (!live) return
      setRecent(list)
      try {
        localStorage.setItem(recentKey, JSON.stringify(list))
      } catch {
        // Not kept: the next page waits for the server once more.
      }
    }
    const read = () => void recentApi.list(RECENT).then(keep, () => {})
    read()
    window.addEventListener(RECENT_EVENT, read)
    return () => {
      live = false
      window.removeEventListener(RECENT_EVENT, read)
    }
  }, [recentKey])
  const [view, setView] = useState<'spaces' | 'tags'>(() => {
    try {
      return localStorage.getItem('nexlore.sidebarView') === 'tags' ? 'tags' : 'spaces'
    } catch {
      return 'spaces'
    }
  })
  const chooseView = (next: 'spaces' | 'tags') => {
    setView(next)
    try {
      localStorage.setItem('nexlore.sidebarView', next)
    } catch {
      // Not remembered: spaces again next time.
    }
  }
  const onNote = useCallback(
    (path: string) => {
      setSheet(false)
      choose(path)
    },
    [choose],
  )
  const { spaces, generation, scan, looks, favorites, setFavorite, reload, status } = useStore()
  const navigate = useNavigate()
  const location = useLocation()
  const menu = useContextMenu()
  const [copied, setCopied] = useState<string | null>(null)
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map())
  const [listings, setListings] = useState<Map<string, Listing | 'loading' | 'failed'>>(new Map())
  const scroller = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 600 })


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
            notes: listing.files.filter(inTree),
            loaded: listing.files.length,
            total: listing.total_files,
            more: false,
          }),
        ),
      )
      .catch(() => setListings((current) => new Map(current).set(path, 'failed')))
  }, [])

  // Everything read before is stale once the vault changed: read again in the background, the old rows standing
  // meanwhile. Dropping them first made the tree shrink for a moment, and the browser pulled the scroll back up.
  const shown = useRef(listings)
  shown.current = listings
  const seen = useRef(generation)
  useEffect(() => {
    if (seen.current === generation) return
    seen.current = generation
    for (const [path, listing] of shown.current) {
      if (typeof listing === 'string') {
        setListings((current) => {
          const next = new Map(current)
          next.delete(path)
          return next
        })
        continue
      }
      vaultApi.folder(path, 0, Math.max(PAGE, listing.loaded)).then(
        (fresh) =>
          setListings((current) =>
            new Map(current).set(path, {
              folders: fresh.folders,
              notes: fresh.files.filter(inTree),
              loaded: fresh.files.length,
              total: fresh.total_files,
              more: false,
            }),
          ),
        // Gone meanwhile (moved, in the trash): its parent no longer shows it.
        () =>
          setListings((current) => {
            const next = new Map(current)
            next.delete(path)
            return next
          }),
      )
    }
  }, [generation])

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
              notes: [...now.notes, ...page.files.filter(inTree)],
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

  /** The templates folder and the daily notes' folder of a space have a symbol of their own, unless one is chosen. */
  const folderIcon = useCallback(
    (path: string): SymbolName | null => {
      const [name, ...rest] = path.split('/')
      const space = spaces.find((item) => item.name === name)
      if (!space || !rest.length) return null
      if (rest.join('/') === (space.template_folder ?? 'Templates')) return 'template'
      if (rest.join('/') === (space.daily_folder ?? 'Daily')) return 'calendar'
      return null
    },
    [spaces],
  )

  // Every open folder that is not read yet.
  // The dots take their colours from the theme: worked out again when it changes.
  const themed = useThemeVersion()
  const rows = useMemo(() => {
    const out: Row[] = []
    const wanted: string[] = []
    const walk = (path: string, name: string, depth: number, count: number, color: string, space: boolean) => {
      const open = isOpen(path)
      // A symbol and colour chosen by hand come first; else the colour nexlore works out, and a dot.
      const look = lookOf(looks, path)
      out.push({ kind: 'folder', path, name, depth, count, color: look.color ?? color, icon: look.icon ?? folderIcon(path), open, space })
      if (!open) return
      const listing = listings.get(path)
      if (listing === undefined || listing === 'loading') {
        if (listing === undefined) wanted.push(path)
        out.push({ kind: 'loading', path, depth: depth + 1 })
        return
      }
      if (listing === 'failed') {
        out.push({ kind: 'failed', path, depth: depth + 1 })
        return
      }
      for (const folder of listing.folders) walk(folder.path, folder.name, depth + 1, folder.notes, folderColor(folder.path, true), false)
      for (const note of listing.notes) out.push({ kind: 'note', path: note.path, title: note.title || note.name.replace(/\.md$/i, ''), depth: depth + 1 })
      if (listing.loaded < listing.total) out.push({ kind: 'more', path, depth: depth + 1 })
      // Opened and nothing in it: say so, and offer the first note.
      if (!listing.folders.length && !listing.notes.length && listing.loaded >= listing.total) out.push({ kind: 'empty', path, depth: depth + 1 })
    }
    spaces.forEach((space, index) => walk(space.name, space.name, 0, space.notes, spaceColor(index), true))
    return { out, wanted, themed }
  }, [spaces, listings, isOpen, looks, folderIcon, themed])

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
    // Unfolded from the strip of symbols, the list is a new element: measured anew, or the one taken away reports a
    // height of nothing and only the few rows drawn ahead show.
  }, [rail])

  // Whether one may write in the space of a path: the menu offers what the server would allow.
  const writable = (path: string | null | undefined) => {
    const role = path ? spaces.find((space) => space.name === path.split('/')[0])?.role : undefined
    return role === 'write' || role === 'manage'
  }

  const toggle = (path: string) => {
    // Opened again after it could not be read: read it again.
    if (!isOpen(path) && listings.get(path) === 'failed') {
      setListings((current) => {
        const next = new Map(current)
        next.delete(path)
        return next
      })
    }
    setToggled((current) => new Map(current).set(path, !isOpen(path)))
  }

  // The note opened is scrolled into view once its row is there (a note far down the tree would stay out of sight).
  // Once per note: scrolling by hand afterwards is not undone. Rows that come above it later (a folder listing that
  // loaded after its own) move the view along, so the note keeps its place on screen instead of sliding away.
  const shownFor = useRef<{ note: string; index: number } | null>(null)
  useEffect(() => {
    const element = scroller.current
    if (!activeNote || !element) return
    const index = rows.out.findIndex((item) => item.kind === 'note' && item.path === activeNote)
    if (index < 0) return
    const shown = shownFor.current
    if (shown?.note === activeNote) {
      if (index !== shown.index) element.scrollTop += (index - shown.index) * ROW
      shown.index = index
      return
    }
    shownFor.current = { note: activeNote, index }
    const top = index * ROW
    if (top < element.scrollTop || top + ROW > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, top - element.clientHeight / 2)
    }
  }, [activeNote, rows.out])

  // A folder just made (or moved into) is shown: it and the folders on its way open.
  useEffect(() => {
    const show = (event: Event) => {
      const parts = (event as CustomEvent<string>).detail.split('/')
      setToggled((current) => {
        const next = new Map(current)
        for (let i = 1; i <= parts.length; i++) next.set(parts.slice(0, i).join('/'), true)
        return next
      })
    }
    window.addEventListener(REVEAL_EVENT, show)
    return () => window.removeEventListener(REVEAL_EVENT, show)
  }, [])

  // A folder asked for (quick switcher after "/", a folder among the favorites): opened as above, then scrolled to
  // and focused once its row is there; on a phone in the sheet.
  useEffect(() => sidebarHere(), [])
  // The folder wish is taken in an effect set up once: it reads the fold through these.
  const railRef = useRef(rail)
  const setRailRef = useRef(setRail)
  useEffect(() => {
    railRef.current = rail
    setRailRef.current = setRail
  }, [rail, setRail])
  // Kept for a moment, not only until first seen: folders above it may still be read and push it down.
  const [target, setTarget] = useState<{ path: string } | null>(null)
  useEffect(() => {
    const take = () => {
      const path = takeFolderWish()
      if (!path) return
      reveal(path)
      setView('spaces')
      if (narrow()) setSheet(true)
      else if (railRef.current) setRailRef.current(false)
      setTarget({ path })
    }
    take()
    window.addEventListener(FOLDER_EVENT, take)
    return () => window.removeEventListener(FOLDER_EVENT, take)
  }, [])
  useEffect(() => {
    if (!target) return
    const timer = window.setTimeout(() => setTarget(null), 3000)
    return () => window.clearTimeout(timer)
  }, [target])
  useEffect(() => {
    const element = scroller.current
    if (!target || !element) return
    const index = rows.out.findIndex((row) => row.kind === 'folder' && row.path === target.path)
    if (index < 0) return
    const top = index * ROW
    if (top < element.scrollTop || top + ROW > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, top - element.clientHeight / 2)
    }
    // The row is drawn only once the list has seen the scroll: a few frames at most.
    let frames = 0
    let stopped = false
    const focus = () => {
      if (stopped) return
      const button = element.querySelector<HTMLElement>(`li[data-path="${CSS.escape(target.path)}"] button[aria-expanded]:not([aria-label])`)
      if (button) {
        // A dialog opened meanwhile (Ctrl+K right after choosing a folder) keeps its focus: the late focus here took
        // the keys away from the field being typed in.
        const inDialog = document.activeElement?.closest('[role="dialog"], dialog') ?? null
        if (document.activeElement !== button && !inDialog) button.focus()
      } else if (++frames < 20) requestAnimationFrame(focus)
    }
    requestAnimationFrame(focus)
    return () => {
      stopped = true
    }
  }, [target, rows.out])

  useEffect(() => {
    const drop = (event: Event) => {
      const gone = (event as CustomEvent<string>).detail
      // Its own listing goes, and so does its row in the listing above it (which is read again only afterwards).
      setListings((current) => {
        const next = new Map<string, Listing | 'loading' | 'failed'>()
        for (const [path, listing] of current) {
          if (within(path, gone)) continue
          next.set(path, typeof listing === 'string' ? listing : { ...listing, folders: listing.folders.filter((folder) => !within(folder.path, gone)) })
        }
        return next
      })
    }
    window.addEventListener(FORGET_EVENT, drop)
    return () => window.removeEventListener(FORGET_EVENT, drop)
  }, [])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(null), 3000)
    return () => window.clearTimeout(timer)
  }, [copied])

  /** Beside the note open now (on the notes page); elsewhere it simply opens. */
  const openRight = (path: string) => {
    const left = location.pathname.startsWith('/note/') ? location.pathname : null
    navigate(left ? `${left}?right=${encodeURIComponent(path)}` : `/note/${path.split('/').map(encodeURIComponent).join('/')}`)
  }

  /** A file from the server, saved by the browser (the session goes along). */
  const download = (url: string) => {
    const link = document.createElement('a')
    link.href = url
    link.download = ''
    link.click()
  }

  /** Into the favorites, or out of them. */
  const favoriteItem = (path: string): MenuItem => {
    const on = favorites.some((favorite) => favorite.path === path)
    return { label: on ? t('menu.unfavorite') : t('menu.favorite'), symbol: 'star', onSelect: () => void setFavorite(path, !on) }
  }

  // Favorites without a group first, then each group in the order its first one came.
  const favoriteGroups = useMemo(() => {
    const groups = new Map<string, Favorite[]>([['', []]])
    for (const favorite of favorites) {
      const members = groups.get(favorite.section) ?? []
      members.push(favorite)
      groups.set(favorite.section, members)
    }
    return [...groups].filter(([, members]) => members.length > 0)
  }, [favorites])
  // A favorite being put into a new group: the dialog asks for the group's name.
  const [grouping, setGrouping] = useState<Favorite | null>(null)
  const favoriteMenu = (favorite: Favorite): MenuItem[] => {
    const sections = favoriteGroups.map(([section]) => section).filter((section) => section && section !== favorite.section)
    return [
      { label: t('menu.open'), symbol: 'note', onSelect: () => openFavorite(favorite) },
      {
        label: t('favorites.group'),
        symbol: 'folder',
        items: [
          ...sections.map((section) => ({ label: section, onSelect: () => void setFavorite(favorite.path, true, section) })),
          ...(favorite.section ? [{ label: t('favorites.noGroup'), onSelect: () => void setFavorite(favorite.path, true, '') }] : []),
          { label: t('favorites.newGroup'), symbol: 'plus', onSelect: () => setGrouping(favorite) },
        ],
      },
      { label: t('menu.unfavorite'), symbol: 'star', onSelect: () => void setFavorite(favorite.path, false) },
    ]
  }

  /** A favorite opens where it is: a note in the note page, a folder in the tree, a file on its page, a heading in its
   * note (scrolled to), a search on the search page. */
  const openFavorite = (favorite: Favorite) => {
    if (favorite.kind === 'note') onNote(favorite.path)
    else if (favorite.kind === 'heading' && favorite.note) navigate(noteUrl(favorite.note) + '#' + encodeURIComponent(favorite.title))
    else if (favorite.kind === 'search') navigate('/search?q=' + encodeURIComponent(favorite.title))
    else if (favorite.kind === 'folder') askFolder(favorite.path)
    else navigate(fileRoute(favorite.path))
  }

  const folderMenu = (row: Extract<Row, { kind: 'folder' }>): MenuItem[] => {
    const write = writable(row.path)
    const manage = row.space && spaces.find((space) => space.name === row.path)?.role === 'manage'
    const items: MenuItem[] = []
    if (write) {
      items.push({ label: t('menu.newNote'), symbol: 'plus', onSelect: () => askNewNote(row.path) })
      items.push({ label: t('menu.newFolder'), symbol: 'folderPlus', onSelect: () => askVaultAction({ kind: 'new-folder', parent: row.path }) })
      items.push({ label: t('bases.new'), symbol: 'table', onSelect: () => askVaultAction({ kind: 'new-base', folder: row.path }) })
      items.push('separator')
    }
    if (write) items.push({ label: t('menu.look'), symbol: 'star', onSelect: () => askVaultAction({ kind: 'look', path: row.path }) })
    if (write && !row.space) {
      items.push({ label: t('menu.rename'), symbol: 'pencil', onSelect: () => askVaultAction({ kind: 'rename', path: row.path, folder: true }) })
      items.push({ label: t('menu.move'), symbol: 'move', onSelect: () => askVaultAction({ kind: 'move', path: row.path, folder: true }) })
    }
    items.push({ label: t('menu.showInGraph'), symbol: 'graph', onSelect: () => (onFolder ? onFolder(row.path) : navigate('/?folder=' + encodeURIComponent(row.path))) })
    items.push(favoriteItem(row.path))
    // Everything of a space in one file, for whoever may read it.
    if (row.space) items.push({ label: t('menu.zip'), symbol: 'download', onSelect: () => download(spaceZipUrl(row.path)) })
    if (manage) items.push({ label: t('menu.spaceSettings'), symbol: 'users', onSelect: () => navigate('/settings?tab=spaces') })
    if (write && !row.space) {
      items.push('separator')
      items.push({ label: t('menu.trash'), symbol: 'trash', danger: true, onSelect: () => askVaultAction({ kind: 'delete', path: row.path, folder: true }) })
    }
    return items
  }

  const noteMenu = (row: Extract<Row, { kind: 'note' }>): MenuItem[] => {
    const write = writable(row.path)
    const items: MenuItem[] = [
      { label: t('menu.open'), symbol: 'note', onSelect: () => onNote(row.path) },
      { label: t('menu.openNewTab'), symbol: 'open', onSelect: () => openInTab(row.path, navigate) },
      { label: t('menu.openRight'), symbol: 'columns', onSelect: () => openRight(row.path) },
      'separator',
    ]
    if (write) {
      items.push({ label: t('menu.rename'), symbol: 'pencil', onSelect: () => askVaultAction({ kind: 'rename', path: row.path, folder: false }) })
      items.push({ label: t('menu.move'), symbol: 'move', onSelect: () => askVaultAction({ kind: 'move', path: row.path, folder: false }) })
      items.push({ label: t('menu.asTemplate'), symbol: 'template', onSelect: () => askVaultAction({ kind: 'as-template', path: row.path }) })
    }
    items.push({ label: t('menu.showInGraph'), symbol: 'graph', onSelect: () => (onFolder ? onNote(row.path) : navigate('/?focus=' + encodeURIComponent(row.path))) })
    items.push(favoriteItem(row.path))
    items.push({
      label: t('menu.copyLink'),
      symbol: 'copy',
      onSelect: () => {
        const text = `[[${baseName(row.path)}]]`
        void copyText(text).then((ok) => ok && setCopied(text))
      },
    })
    if (write) {
      items.push('separator')
      items.push({ label: t('menu.trash'), symbol: 'trash', danger: true, onSelect: () => askVaultAction({ kind: 'delete', path: row.path, folder: false }) })
    }
    return items
  }

  const first = Math.max(0, Math.floor(viewport.top / ROW) - 10)
  const last = Math.min(rows.out.length, Math.ceil((viewport.top + viewport.height) / ROW) + 10)
  const endsInView = rows.out.slice(first, last).filter((row) => row.kind === 'more').map((row) => row.path).join('\n')
  useEffect(() => {
    for (const path of endsInView.split('\n').filter(Boolean)) loadMore(path)
  }, [endsInView, loadMore])

  // Dragging a note or folder onto a folder moves it there (P4.16), as the dialog "Move …" does.
  const dragged = useRef<string | null>(null)
  const [dropOn, setDropOn] = useState<string | null>(null)
  const takes = (folder: string, path: string | null): path is string =>
    !!path && writable(folder) && !within(folder, path) && folderOf(path) !== folder
  const startDrag = (event: ReactDragEvent<HTMLElement>, path: string) => {
    dragged.current = path
    event.dataTransfer.setData(DRAG_TYPE, path)
    event.dataTransfer.effectAllowed = 'move'
    const end = () => {
      dragged.current = null
      setDropOn(null)
    }
    event.currentTarget.addEventListener('dragend', end, { once: true })
  }
  const overFolder = (event: ReactDragEvent<HTMLElement>, folder: string) => {
    if (!takes(folder, dragged.current)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropOn(folder)
  }
  const dropOnFolder = (event: ReactDragEvent<HTMLElement>, folder: string) => {
    const path = dragged.current
    dragged.current = null
    setDropOn(null)
    if (!takes(folder, path)) return
    event.preventDefault()
    askVaultAction({ kind: 'move-to', path, target: folder })
  }

  // The arrows walk the tree; right opens a folder, left closes it (P4.16: only Tab moved).
  const stepKeys = (event: ReactKeyboardEvent<HTMLElement>, folder?: string, open?: boolean) => {
    if (folder && ((event.key === 'ArrowRight' && !open) || (event.key === 'ArrowLeft' && open))) {
      event.preventDefault()
      toggle(folder)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const element = scroller.current
    if (!element) return
    const down = event.key === 'ArrowDown'
    const from = event.currentTarget
    const step = () => {
      const items = [...element.querySelectorAll<HTMLElement>('li[data-path] > button, li[data-path] > div > button[aria-expanded]:not([aria-label])')]
      items.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      const next = items[items.indexOf(from) + (down ? 1 : -1)]
      if (next) {
        next.focus({ preventScroll: true })
        next.scrollIntoView({ block: 'nearest' })
        return true
      }
      return false
    }
    // At the edge of the rows drawn: a row further, then once more.
    if (!step()) {
      element.scrollTop += down ? ROW : -ROW
      requestAnimationFrame(() => void step())
    }
  }

  const renderRow = (row: Row) => {
    if (row.kind === 'loading' || row.kind === 'more') {
      return <div className="py-1 text-xs text-mist-600" style={{ paddingLeft: row.depth * 12 + 10 }}>{t('common.loading')}</div>
    }
    if (row.kind === 'empty') {
      return (
        <div className="flex h-full items-center gap-2 text-xs text-mist-600" style={{ paddingLeft: row.depth * 12 + 10 }} data-testid="sidebar-empty">
          <span className="truncate">{t('sidebar.nothingHere')}</span>
          {writable(row.path) && (
            <button type="button" onClick={() => askNewNote(row.path)} className="shrink-0 rounded px-1.5 py-0.5 text-accent-400 hover:bg-ink-850">
              {t('sidebar.firstNote')}
            </button>
          )}
        </div>
      )
    }
    if (row.kind === 'failed') {
      return (
        <div className="flex h-full items-center gap-2 text-xs text-bad-500" style={{ paddingLeft: row.depth * 12 + 10 }}>
          <span className="truncate">{t('sidebar.loadFailed')}</span>
          <button type="button" onClick={() => load(row.path)} className="shrink-0 rounded px-1.5 py-0.5 text-accent-400 hover:bg-ink-850">
            {t('sidebar.retry')}
          </button>
        </div>
      )
    }
    if (row.kind === 'note') {
      return (
        <button
          type="button"
          // With Ctrl or Cmd, or the middle button: in a tab of its own.
          onClick={(event) =>
            /\.base$/i.test(row.path) ? navigate(fileRoute(row.path)) : event.ctrlKey || event.metaKey ? openInTab(row.path, navigate) : onNote(row.path)
          }
          onAuxClick={(event) => {
            if (event.button !== 1) return
            event.preventDefault()
            openInTab(row.path, navigate)
          }}
          {...menuTriggers((x, y) => menu.open(x, y, noteMenu(row)))}
          draggable={writable(row.path)}
          onDragStart={(event) => startDrag(event, row.path)}
          onKeyDown={(event) => stepKeys(event)}
          className={
            'flex h-full w-full items-center gap-2 rounded-lg pr-2 text-left text-[13px] ' +
            (activeNote === row.path ? 'bg-accent-500/15 text-accent-400' : 'text-mist-400 hover:bg-ink-850 hover:text-mist-100')
          }
          style={{ paddingLeft: row.depth * 12 + 10 }}
          data-new={news.paths.has(row.path) || undefined}
          title={news.paths.has(row.path) ? t('news.newDot') : undefined}
        >
          <Symbol name={/\.base$/i.test(row.path) ? 'table' : 'note'} className="h-3.5 w-3.5 shrink-0 opacity-60" />
          <span className="truncate">{/\.base$/i.test(row.path) ? row.title.replace(/\.base$/i, '') : row.title}</span>
          {news.paths.has(row.path) && <span aria-hidden="true" className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent-400" />}
        </button>
      )
    }
    return (
      <div
        className={
          'group flex h-full items-center gap-1 rounded-lg pr-1.5 ' +
          (dropOn === row.path ? 'bg-accent-500/20 ring-1 ring-accent-500/60 ' : '') +
          (activeFolder === row.path ? 'bg-accent-500/10 text-accent-400' : 'text-mist-300 hover:bg-ink-850')
        }
        style={{ paddingLeft: row.depth * 12 + 4 }}
        {...menuTriggers((x, y) => menu.open(x, y, folderMenu(row)))}
        draggable={!row.space && writable(row.path)}
        onDragStart={(event) => startDrag(event, row.path)}
        onDragOver={(event) => overFolder(event, row.path)}
        onDragLeave={() => setDropOn((now) => (now === row.path ? null : now))}
        onDrop={(event) => dropOnFolder(event, row.path)}
        data-testid="sidebar-folder"
      >
        <button type="button" onClick={() => toggle(row.path)} className="rounded p-1 text-mist-600 hover:text-mist-100" aria-label={row.open ? t('sidebar.collapse') : t('sidebar.expand')} aria-expanded={row.open}>
          <Symbol name={row.open ? 'chevronDown' : 'chevronRight'} className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => toggle(row.path)}
          onKeyDown={(event) => stepKeys(event, row.path, row.open)}
          aria-expanded={row.open}
          className={'flex min-w-0 flex-1 items-center gap-2 text-left ' + (row.space ? 'text-[13px] font-semibold text-mist-100' : 'text-[13px]')}
        >
          {row.icon ? (
            <span className="shrink-0" style={{ color: row.color }} data-look={row.icon}>
              <LookIcon name={row.icon} className="h-3.5 w-3.5" />
            </span>
          ) : (
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: row.color }} />
          )}
          <span className="truncate">{row.name}</span>
          {/* Only under the pointer or the keys: a quiet list, the number when asked for. */}
          <span className="ml-auto shrink-0 text-[11px] text-mist-600 tabular-nums opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" data-testid="folder-count">{row.count}</span>
        </button>
        {writable(row.path) && (
          <button
            type="button"
            onClick={() => askNewNote(row.path)}
            className="shrink-0 rounded p-0.5 text-mist-500 opacity-0 group-hover:opacity-100 hover:bg-ink-800 hover:text-mist-100 focus-visible:opacity-100"
            aria-label={t('sidebar.newNoteIn', { folder: row.name })}
            title={t('sidebar.newNoteIn', { folder: row.name })}
          >
            <Symbol name="plus" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    )
  }

  // Folded: a strip of symbols; each opens the sidebar again, where it leads.
  if (rail && !sheet) {
    const unfold = (then?: () => void) => {
      setRail(false)
      then?.()
    }
    const strip: { label: string; symbol: SymbolName; run?: () => void }[] = [
      { label: t('sidebar.spaces'), symbol: 'folder', run: () => chooseView('spaces') },
      { label: t('tags.title'), symbol: 'tag', run: () => chooseView('tags') },
      { label: t('sidebar.recent'), symbol: 'clock', run: () => showRecent(true) },
      ...(favorites.length > 0 ? [{ label: t('sidebar.favorites'), symbol: 'star' as const }] : []),
    ]
    return (
      <nav aria-label={t('sidebar.label')} data-testid="sidebar-rail" className="hidden w-12 shrink-0 flex-col items-center gap-1 border-r border-ink-700/80 bg-ink-950/60 py-2.5 md:flex">
        <button type="button" onClick={() => unfold()} title={t('sidebar.unfold')} aria-label={t('sidebar.unfold')} className="rounded-lg p-2 text-mist-400 hover:bg-ink-850 hover:text-mist-100">
          <Symbol name="sidebar" className="h-4 w-4" />
        </button>
        <span aria-hidden="true" className="my-1 h-px w-6 bg-ink-700" />
        {strip.map((item) => (
          <button key={item.symbol} type="button" onClick={() => unfold(item.run)} title={item.label} aria-label={item.label} className="rounded-lg p-2 text-mist-500 hover:bg-ink-850 hover:text-mist-100">
            <Symbol name={item.symbol} className="h-4 w-4" />
          </button>
        ))}
        {news.count + news.notices.length + news.requests.length > 0 && (
          <button type="button" onClick={() => unfold(() => showNews(true))} title={t('news.section', { count: news.count + news.notices.length + news.requests.length })} aria-label={t('news.section', { count: news.count + news.notices.length + news.requests.length })} className="relative rounded-lg p-2 text-accent-400 hover:bg-ink-850">
            <Symbol name="sparkle" className="h-4 w-4" />
            <span aria-hidden="true" className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-accent-400" />
          </button>
        )}
      </nav>
    )
  }

  return (
    <>
    {/* The dimmed page behind the sheet closes it; the button in the sheet does the same for keys and readers. */}
    {sheet && <div aria-hidden="true" onClick={() => setSheet(false)} className="fixed inset-0 z-30 bg-scrim md:hidden" data-testid="sidebar-scrim" />}
    <aside
      aria-label={t('sidebar.label')}
      data-testid="sidebar"
      data-sheet={sheet || undefined}
      className={
        sheet
          ? 'fixed inset-y-0 left-0 z-40 flex w-[85vw] max-w-80 flex-col border-r border-ink-700/80 bg-ink-950 pt-[env(safe-area-inset-top)] shadow-2xl md:static md:z-auto md:w-64 md:max-w-none md:shrink-0 md:bg-ink-950/60 md:pt-0 md:shadow-none'
          : 'hidden w-64 shrink-0 flex-col border-r border-ink-700/80 bg-ink-950/60 md:flex'
      }
    >
      {sheet && (
        <div className="flex items-center justify-between border-b border-ink-700/60 px-4 py-2.5 md:hidden">
          <span className="text-sm font-semibold text-mist-100">{t('sidebar.label')}</span>
          <button type="button" onClick={() => setSheet(false)} aria-label={t('common.close')} className="rounded-full p-1.5 text-mist-400 hover:bg-ink-850 hover:text-mist-100">
            <Symbol name="close" className="h-4 w-4" />
          </button>
        </div>
      )}
      {(news.count > 0 || news.mentions.length > 0 || news.notices.length > 0 || news.requests.length > 0) && (
        <div className="border-b border-ink-700/60 px-2 pt-3 pb-2" data-testid="sidebar-news">
          <div className="flex items-center gap-2 px-2">
            {/* One line from the start: the dots in the tree say where; opened, the list (remembered in this browser). */}
            <button type="button" onClick={() => showNews(!newsOpen)} aria-expanded={newsOpen} className="flex flex-1 items-center gap-1 text-left text-[11px] font-semibold tracking-wider text-accent-400 uppercase">
              <Symbol name={newsOpen ? 'chevronDown' : 'chevronRight'} className="h-3 w-3" />
              {t('news.section', { count: news.count + news.mentions.length + news.notices.length + news.requests.length })}
            </button>
            <button type="button" onClick={() => void seenAll()} className="text-[11px] text-mist-500 hover:text-mist-200">{t('news.allSeen')}</button>
          </div>
          {newsOpen && (
          <ul className="nn-scroll mt-1 max-h-44 overflow-y-auto">
            {news.requests.map((request) => (
              <li key={'r' + request.id} data-request={request.id} className="rounded-lg px-2 py-1 text-[13px] text-mist-300">
                <Link to="/requests" className="block leading-snug hover:text-mist-100">
                  {t('requests.news', { key: request.key_name, what: i18n.exists(`mcp.tools.${request.tool}`) ? t(`mcp.tools.${request.tool}`) : request.tool })}
                  <span className="ml-1 rounded-full bg-warn-500/15 px-1.5 text-[11px] text-warn-500">{t('requests.status.waiting')}</span>
                </Link>
              </li>
            ))}
            {news.notices.map((notice) => (
              <li key={'n' + notice.id} data-notice={notice.kind} className="rounded-lg px-2 py-1 text-[13px] text-mist-300">
                <p className="leading-snug">
                  {t(`notices.${notice.kind}`, { actor: nameOf(notice.actor), subject: nameOf(notice.subject), space: notice.space, role: notice.role ? t(`roles.${notice.role}`) : '' })}
                </p>
                <div className="mt-1 flex gap-2">
                  {notice.kind === 'invite' ? (
                    <>
                      <button type="button" onClick={() => void answerNotice(notice.id, true).then(() => reload())} className="rounded-md bg-accent-500/15 px-2 py-0.5 text-xs text-accent-300 hover:bg-accent-500/25">{t('notices.accept')}</button>
                      <button type="button" onClick={() => void answerNotice(notice.id, false)} className="rounded-md px-2 py-0.5 text-xs text-mist-400 hover:bg-ink-850">{t('notices.decline')}</button>
                    </>
                  ) : (
                    <button type="button" onClick={() => void answerNotice(notice.id, false).then(() => reload())} className="rounded-md px-2 py-0.5 text-xs text-mist-400 hover:bg-ink-850">{t('notices.seen')}</button>
                  )}
                </div>
              </li>
            ))}
            {news.mentions.slice(0, 6).map((item) => (
              <li key={'m' + item.thread}>
                <button type="button" onClick={() => onNote(item.path)} title={item.excerpt} data-mention={item.thread} className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] text-mist-300 hover:bg-ink-850">
                  <span aria-hidden="true" className="shrink-0 text-accent-400">@</span>
                  <span className="min-w-0 flex-1 truncate">{t('news.mention', { name: nameOf(item.author), title: item.title })}</span>
                </button>
              </li>
            ))}
            {news.notes.slice(0, 12).map((item) => (
              <li key={item.path}>
                <button type="button" onClick={() => onNote(item.path)} title={item.author ? t('news.by', { name: nameOf(item.author) }) : t('news.outside')} className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] text-mist-300 hover:bg-ink-850">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-400" />
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                </button>
              </li>
            ))}
          </ul>
          )}
        </div>
      )}
      {recent.length > 0 && (
        <div className="border-b border-ink-700/60 px-2 pt-3 pb-2" data-testid="sidebar-recent">
          <FoldHead label={t('sidebar.recent')} open={recentOpen} onToggle={() => showRecent(!recentOpen)} />
          {recentOpen && (
            <ul className="nn-scroll max-h-44 overflow-y-auto">
              {recent.map((item) => (
                <li key={item.path}>
                  <button
                    type="button"
                    onClick={() => onNote(item.path)}
                    title={item.path}
                    className={'flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] hover:bg-ink-850 ' + (item.path === activeNote ? 'bg-accent-500/10 text-accent-300' : 'text-mist-300')}
                  >
                    <Symbol name="clock" className="h-3.5 w-3.5 shrink-0 text-mist-600" />
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {favorites.length > 0 && (
        <div className="border-b border-ink-700/60 px-2 pt-3 pb-2" data-testid="sidebar-favorites">
          <FoldHead label={t('sidebar.favorites')} open={favoritesOpen} onToggle={() => showFavorites(!favoritesOpen)} />
          {favoritesOpen && (
          <ul className="nn-scroll max-h-44 overflow-y-auto">
            {favoriteGroups.map(([section, members]) => [
              section ? (
                <li key={'group:' + section} className="px-2 pt-2 pb-0.5 text-[10px] font-semibold tracking-wider text-mist-600 uppercase" data-testid="favorite-group">
                  {section}
                </li>
              ) : null,
              ...members.map((favorite) => (
              <li key={favorite.path} data-favorite={favorite.path}>
                <button
                  type="button"
                  onClick={() => openFavorite(favorite)}
                  {...menuTriggers((x, y) => menu.open(x, y, favoriteMenu(favorite)))}
                  title={favorite.kind === 'search' ? favorite.title : favorite.path}
                  className={
                    'flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] hover:bg-ink-850 ' +
                    (favorite.path === activeNote ? 'bg-accent-500/10 text-accent-300' : 'text-mist-300')
                  }
                >
                  <Symbol name={FAVORITE_SYMBOLS[favorite.kind]} className="h-3.5 w-3.5 shrink-0 text-mist-600" />
                  <span className="min-w-0 flex-1 truncate">
                    {favorite.title}
                    {/* A heading says whose: "Section 4" alone was ambiguous (P4.19). */}
                    {favorite.kind === 'heading' && favorite.note && (
                      <span className="ml-1.5 text-xs text-mist-600">{baseName(favorite.note).replace(/\.md$/i, '')}</span>
                    )}
                  </span>
                </button>
              </li>
              )),
            ])}
          </ul>
          )}
        </div>
      )}
      <div className="px-2 pt-3">
        <div className="mb-2 flex items-center justify-between gap-2 px-1">
          {/* Spaces and folders, or the tags of every readable note; remembered in this browser. */}
          <div role="tablist" aria-label={t('tags.view')} className="flex items-center gap-0.5">
            {(['spaces', 'tags'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                role="tab"
                aria-selected={view === kind}
                onClick={() => chooseView(kind)}
                className={'rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-wider uppercase ' + (view === kind ? 'bg-ink-850 text-mist-200' : 'text-mist-600 hover:text-mist-300')}
              >
                {kind === 'spaces' ? t('sidebar.spaces') : t('tags.title')}
              </button>
            ))}
          </div>
          <span className="flex items-center gap-0.5">
            {view === 'spaces' && (
              <button
                type="button"
                onClick={() => askVaultAction({ kind: 'new-space' })}
                className="rounded-md p-1 text-mist-500 hover:bg-ink-850 hover:text-mist-100"
                title={t('sidebar.newSpace')}
                aria-label={t('sidebar.newSpace')}
              >
                <Symbol name="plus" className="h-4 w-4" />
              </button>
            )}
            {!sheet && (
              <button type="button" onClick={() => setRail(true)} className="rounded-md p-1 text-mist-500 hover:bg-ink-850 hover:text-mist-100" title={t('sidebar.fold')} aria-label={t('sidebar.fold')}>
                <Symbol name="sidebar" className="h-4 w-4" />
              </button>
            )}
          </span>
        </div>
      </div>
      {view === 'tags' && <TagTree activeNote={activeNote} onNote={onNote} />}
      <div ref={scroller} hidden={view !== 'spaces'} className="nn-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3" data-testid="sidebar-tree">
        {/* Only once the spaces are there: while they load, an account with spaces would see the first step. */}
        {spaces.length === 0 && status === 'ready' && (
          <div className="flex flex-col items-start gap-2 px-2">
            <p className="text-sm text-mist-500">{scan.running ? t('scan.plain') : t('sidebar.empty')}</p>
            {!scan.running && (
              <button type="button" onClick={() => askVaultAction({ kind: 'new-space' })} className="inline-flex items-center gap-1.5 rounded-full border border-accent-500/60 px-3 py-1 text-sm text-accent-400 hover:bg-accent-500/10">
                <Symbol name="plus" /> {t('sidebar.newSpace')}
              </button>
            )}
          </div>
        )}
        <ul className="relative" style={{ height: rows.out.length * ROW }}>
          {rows.out.slice(first, last).map((row, i) => (
            <li key={row.kind + ':' + row.path} data-path={row.path} className="absolute right-0 left-0" style={{ top: (first + i) * ROW, height: ROW }}>
              {/* A line under each open folder's arrow, down along what it holds. */}
              {Array.from({ length: row.depth }, (_, level) => (
                <span key={level} aria-hidden="true" data-testid="tree-guide" className="pointer-events-none absolute inset-y-0 w-px bg-ink-700/70" style={{ left: level * 12 + 15 }} />
              ))}
              {renderRow(row)}
            </li>
          ))}
        </ul>
      </div>
      {copied && (
        <p role="status" className="border-t border-ink-700/80 px-4 py-2 text-xs text-mist-400">
          {t('menu.copied', { text: copied })}
        </p>
      )}
      {menu.element}
      {grouping && (
        <NameDialog
          title={t('favorites.groupTitle', { name: grouping.title })}
          label={t('favorites.groupLabel')}
          initial={grouping.section}
          suggestions={favoriteGroups.map(([section]) => section).filter(Boolean)}
          onSave={(section) => {
            void setFavorite(grouping.path, true, section)
            setGrouping(null)
          }}
          onCancel={() => setGrouping(null)}
        />
      )}
    </aside>
    </>
  )
}

/** Open or folded, remembered in this browser under `key` (open unless folded once). */
function useFold(key: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) !== 'closed'
    } catch {
      return true
    }
  })
  const show = (next: boolean) => {
    setOpen(next)
    try {
      if (next) localStorage.removeItem(key)
      else localStorage.setItem(key, 'closed')
    } catch {
      // Not remembered: open again next time.
    }
  }
  return [open, show]
}

/** The head of a section that folds: its name after the arrow. */
function FoldHead({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} className="mb-1 flex w-full items-center gap-1 px-2 text-left text-[11px] font-semibold tracking-wider text-mist-600 uppercase hover:text-mist-300">
      <Symbol name={open ? 'chevronDown' : 'chevronRight'} className="h-3 w-3" />
      {label}
    </button>
  )
}
