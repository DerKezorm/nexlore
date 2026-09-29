/**
 * One note: reading view or editor, with backlinks, links and versions on the right.
 *
 * Editing takes the note's lock first; somebody else holding it sees who, and reads. The lock is renewed every
 * 30 seconds while the editor is open and given back on leaving. Typing saves by itself after a pause, always against
 * the state the editor started from: when the file changed in between (Obsidian, another device), the server writes
 * the edit into a conflict copy instead of overwriting, and the page offers to compare both.
 *
 * Every few seconds the page asks how the note stands on disk. Read or opened without own changes, a note changed
 * elsewhere is loaded again quietly; with own changes nothing is touched, and the next save becomes a conflict copy.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { ApiError, draftsApi, vaultApi, type DraftInfo, type Links, type NoteData, type Uploaded, type VersionInfo, recentApi, themesApi, proposalsApi, type NoteNews, type Proposal } from '../api/client'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { ConflictCompare } from '../components/ConflictCompare'
import { DraftCompare } from '../components/DraftCompare'
import type { EditorHandle, EditorMode } from '../components/NoteEditor'
import { Sidebar } from '../components/Sidebar'
import { Symbol } from '../components/Symbol'
import { NoteStart } from '../components/NoteStart'
import { Outline } from '../components/Outline'
import { CompareDialog } from '../components/CompareDialog'
import { BaseBlocks } from '../components/BaseBlocks'
import { ProposeDialog } from '../components/ProposeDialog'
import { seenNote } from '../lib/news'
import { useEnrich } from '../lib/enrich'
import { noteClasses } from '../lib/appearance'
import { ensureSpaceTheme } from '../lib/themes'
import { TabBar } from '../components/TabBar'
import { openInTab } from '../lib/tabs'
import { copiesOf, originalOf } from '../lib/compare'
import { errorText } from '../lib/errors'
import { isFileTarget, isNotePath } from '../lib/files'
import { distinctOutgoing, LinkIndex, linkedSpace, linkName } from '../lib/links'
import { fileRoute, formatDate, renderMarkdown } from '../lib/markdown'
import { baseName, folderOf, noteUrl } from '../lib/vault'
import { versionSource } from '../lib/versions'
import { copyText, LEAVING_EVENT, within, type Leaving } from '../lib/vaultActions'
import { useCommands, type Command } from '../lib/commands'
import { HEADING_EVENT, setShownNote } from '../lib/shell'
import { useAuth } from '../state/auth'
import { useStore } from '../state/store'
import { LocalGraph } from '../components/LocalGraph'
import { NoteEmbeds } from '../components/NoteEmbeds'
import { ShareDialog } from '../components/ShareDialog'
import { folderColor } from '../graph/palette'
import { PluginFrame } from '../plugins/host'
import { PluginBlocks, PluginPanels, ViewSwitch } from '../plugins/NotePlugins'
import { useEnabledPlugins, viewFor } from '../plugins/registry'

// The editor (Milkdown, CodeMirror for code, KaTeX) is most of the weight: loaded when somebody starts editing.
const NoteEditor = lazy(() => import('../components/NoteEditor').then((module) => ({ default: module.NoteEditor })))

const SAVE_PAUSE = 1200
const HEARTBEAT = 30_000
const POLL = 5_000

/** Whether the window is at least as wide as Tailwind's `xl`. */
function useWide(): boolean {
  const query = '(min-width: 1280px)'
  const [wide, setWide] = useState(() => window.matchMedia?.(query).matches ?? true)
  useEffect(() => {
    const list = window.matchMedia?.(query)
    if (!list) return
    const update = () => setWide(list.matches)
    list.addEventListener('change', update)
    return () => list.removeEventListener('change', update)
  }, [])
  return wide
}

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'failed' | 'refreshed'

/**
 * The notes page: the sidebar, the note, and on request a second note beside it (`?right=`, from the menu "Open to
 * the right"). Each note is a pane of its own with everything a note has; the right one changes only `right` when a
 * link in it is followed. On a narrow screen only the left one shows.
 */
export function NotePage() {
  // Already decoded by the router; decoding again breaks names with a "%" in them.
  const path = useParams()['*'] ?? ''
  const [params] = useSearchParams()
  const right = path ? params.get('right') : null
  const navigate = useNavigate()
  const open = useCallback((next: string) => navigate(noteUrl(next) + (right ? `?right=${encodeURIComponent(right)}` : '')), [navigate, right])
  return (
    <>
      <Sidebar key={'tree-' + path} activeNote={path || null} onNote={open} />
      {path ? (
        <NotePane path={path} side="left" right={right} />
      ) : (
        <NoteStart onNote={open} />
      )}
      {right && <NotePane path={right} side="right" right={right} mirror={right === path} />}
    </>
  )
}

type PaneProps = {
  path: string
  /** Left: the note of the address. Right: the second note, beside it. */
  side: 'left' | 'right'
  /** The note on the right, if any: the left pane keeps it when it moves on, and gives up its right column. */
  right: string | null
  /** The same note on both sides: the right one only reads (two editors on one note would write over each other). */
  mirror?: boolean
}

function NotePane({ path, side, right, mirror = false }: PaneProps) {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const split = right !== null
  const { t } = useTranslation()
  const { reload, spaces, generation, favorites, setFavorite } = useStore()
  const { me } = useAuth()
  const navigate = useNavigate()
  const [sharing, setSharing] = useState(false)
  // The right column (and the local graph in it) from 1280 pixels on; below, the local graph goes under the text.
  const wide = useWide()

  const [note, setNote] = useState<NoteData | null>(null)
  const [links, setLinks] = useState<Links | null>(null)
  // Where wiki links lead, asked from the server; the note's saved links give the first answers.
  const linkIdx = useMemo(() => new LinkIndex(path), [path])
  useEffect(() => () => linkIdx.close(), [linkIdx])
  useEffect(() => {
    if (links) linkIdx.seed(links.outgoing)
  }, [links, linkIdx])
  // The note's conflict copies, or, for a copy, its note (the server looks next to it, the folder is not read).
  const [siblings, setSiblings] = useState<string[]>([])
  // A note just deleted: the page stays for a moment while the router moves on, and the spaces loaded again in that
  // moment must not make it ask after the note (a 404 in the console). Set before the delete, in the click.
  const [gone, setGone] = useState<string | null>(null)
  const leaving = gone === path
  useEffect(() => {
    // No note chosen (the notes page itself): nothing to ask after.
    if (leaving || !path) return
    let live = true
    vaultApi.copies(path).then(
      (found) => live && setSiblings(found.paths),
      () => live && setSiblings([]),
    )
    return () => {
      live = false
    }
  }, [path, generation, leaving])
  const [problem, setProblem] = useState<string | null>(null)
  // Editing belongs to one note: moving on to another ends it in the same render, so nothing of the old note's
  // editor (its text, its lock, its save) can ever run against the new path.
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const editing = editingPath === path
  const [mode, setMode] = useState<EditorMode>('visual')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [conflict, setConflict] = useState<string | null>(null)
  const [comparing, setComparing] = useState<{ note: string; copy: string } | null>(null)
  // Drafts an AI proposed for this note over MCP (M7); only the own ones come.
  const [drafts, setDrafts] = useState<DraftInfo[]>([])
  const [draftShown, setDraftShown] = useState<number | null>(null)
  const [lockHolder, setLockHolder] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  // Files only this note uses, offered to go into the trash with it; and whether they do.
  const [own, setOwn] = useState<string[]>([])
  const [withOwn, setWithOwn] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const afterOpen = useRef<string | null>(null)
  // Plugins (M7): panels, code blocks and a view of their own, each in a locked frame.
  const plugins = useEnabledPlugins()
  const article = useRef<HTMLElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [showText, setShowText] = useState(false)
  // What an upload did, said once (place and device removed, the file was there already).
  const [info, setInfo] = useState<string | null>(null)

  // The editor, the text it held when last asked, what was last written, and the file state it was written against.
  const editor = useRef<EditorHandle>(null)
  const draft = useRef('')
  const saved = useRef('')
  const base = useRef('')
  // Changes counted, so a save knows whether more came while it was under way (without serializing again).
  const edits = useRef(0)
  const savedEdits = useRef(0)
  const saving = useRef(false)
  const timer = useRef<number | null>(null)
  const current = useRef(path)
  current.current = path
  const editingNow = useRef(editing)
  editingNow.current = editing

  /** Where a note opens from this pane: the right pane changes only `right`; the left one keeps the right note. */
  const go = useCallback(
    (next: string, edit = false) => {
      if (side === 'right') {
        navigate({ pathname: location.pathname, search: `?right=${encodeURIComponent(next)}` })
        return
      }
      const query = new URLSearchParams()
      if (right) query.set('right', right)
      if (edit) query.set('edit', '1')
      const search = query.toString()
      navigate(noteUrl(next) + (search ? `?${search}` : ''))
    },
    [side, right, navigate, location.pathname],
  )
  const open = useCallback((next: string) => go(next), [go])

  // The "More" menu closes on a click elsewhere and on Escape, like any menu.
  const menu = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const close = (event: Event) => {
      const element = menu.current
      if (!element?.open) return
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !element.contains(event.target as Node)) {
        element.open = false
        if (event instanceof KeyboardEvent) element.querySelector('summary')?.focus()
      }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [])

  const readDraft = () => {
    if (editor.current) draft.current = editor.current.text()
    return draft.current
  }

  // "Opened last": told once per note, after it loaded (a note that is not there is no note one opened). The answer
  // says what others changed since the last visit; proposals of readers wait on the note.
  const told = useRef<string | null>(null)
  const [changed, setChanged] = useState<NoteNews | null>(null)
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [comparing2, setComparing2] = useState<{ kind: 'news'; left: string } | { kind: 'proposal'; proposal: Proposal } | null>(null)
  const [proposing, setProposing] = useState(false)
  const [proposalProblem, setProposalProblem] = useState<string | null>(null)
  const load = useCallback(async (target: string) => {
    try {
      const [data, found] = await Promise.all([vaultApi.note(target), vaultApi.links(target)])
      if (current.current !== target) return
      setNote(data)
      setLinks(found)
      setProblem(null)
      if (side === 'left' && !mirror && told.current !== target) {
        told.current = target
        recentApi.opened(target).then(
          (answer) => {
            if (current.current === target) setChanged(answer.news)
            seenNote(target)
          },
          () => {},
        )
        proposalsApi.forNote(target).then(
          (found) => current.current === target && setProposals(found),
          () => {},
        )
      }
    } catch (error) {
      if (current.current !== target) return
      setNote(null)
      setLinks(null)
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }, [side, mirror])

  /** `saved` (or nothing to save), `ended` (a conflict or a lost lock ended editing), `failed` (still editing). */
  const save = useCallback(async (): Promise<'saved' | 'ended' | 'failed'> => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    const mark = edits.current
    const text = readDraft()
    if (text === saved.current) {
      savedEdits.current = mark
      setSaveState((state) => (state === 'pending' ? 'saved' : state))
      return 'saved'
    }
    saving.current = true
    setSaveState('saving')
    try {
      const result = await vaultApi.save(path, text, base.current)
      if (result.conflict) {
        // The text is safe in the copy. Leaving the editor must not save it a second time against the old state.
        saved.current = text
        draft.current = text
        savedEdits.current = edits.current
        setConflict(result.conflict)
        setEditingPath(null)
        setSaveState('idle')
        await vaultApi.unlock(path).catch(() => undefined)
        await Promise.all([load(path), reload()])
        return 'ended'
      }
      saved.current = text
      base.current = result.hash
      savedEdits.current = mark
      setSaveState(edits.current === mark ? 'saved' : 'pending')
      return 'saved'
    } catch (error) {
      setSaveState('failed')
      if (error instanceof ApiError && error.code === 'locked') {
        setLockHolder(String(error.values.holder ?? ''))
        setEditingPath(null)
        return 'ended'
      }
      return 'failed'
    } finally {
      saving.current = false
    }
  }, [path, load, reload])

  const startEditing = useCallback(async () => {
    if (!note || note.readonly) return
    // The note as it is now, read after the lock is ours: what the page shows may be older (a save just before, a
    // change made elsewhere since the last look).
    let fresh: NoteData
    try {
      await vaultApi.lock(path)
      fresh = await vaultApi.note(path)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'locked') setLockHolder(String(error.values.holder ?? ''))
      else setProblem(error instanceof ApiError ? error.code : 'internal_error')
      return
    }
    if (current.current !== path) return
    setNote(fresh)
    draft.current = fresh.content
    saved.current = fresh.content
    base.current = fresh.hash
    edits.current = 0
    savedEdits.current = 0
    setLockHolder(null)
    setConflict(null)
    setSaveState('idle')
    setMode('visual')
    setEditingPath(path)
  }, [note, path])

  /** True when editing has ended; false when the last save failed and the text is still only in the editor. */
  const stopEditing = useCallback(async (): Promise<boolean> => {
    const result = await save()
    // After a conflict, save() has ended editing, given the lock back and loaded the note already.
    if (result !== 'saved') return result === 'ended'
    setEditingPath(null)
    await vaultApi.unlock(path).catch(() => undefined)
    await Promise.all([load(path), reload()])
    return true
  }, [save, path, load, reload])

  // The sidebar is about to move this note, or rename or trash it or a folder it lies in: what is typed is saved
  // first, and the page stops asking after the old path (it follows to the new one, or leaves).
  useEffect(() => {
    const leaving = (event: Event) => {
      const detail = (event as CustomEvent<Leaving>).detail
      if (!path || !within(path, detail.path)) return
      if (editingNow.current) detail.wait(stopEditing())
      setGone(path)
    }
    window.addEventListener(LEAVING_EVENT, leaving)
    return () => window.removeEventListener(LEAVING_EVENT, leaving)
  }, [path, stopEditing])

  // A different note: back to reading, fresh data.
  useEffect(() => {
    setEditingPath(null)
    setConflict(null)
    setComparing(null)
    setLockHolder(null)
    setRenaming(null)
    setShowText(false)
    setNotice(null)
    // A message meant for the note just opened (after a rename: how many notes had their links updated).
    setInfo(afterOpen.current)
    afterOpen.current = null
    setSaveState('idle')
    if (path) void load(path)
  }, [path, load])

  // Coming from "new note" (or a click on a link to a note not yet written): straight into the editor.
  useEffect(() => {
    if (side === 'left' && note && params.get('edit') === '1' && !editing) {
      // Only "edit" goes: a note open on the right stays.
      setParams(
        (current) => {
          current.delete('edit')
          return current
        },
        { replace: true },
      )
      void startEditing()
    }
  }, [side, note, params, editing, setParams, startEditing])

  // While editing: keep the lock, and give it back (with the last words saved) when the page goes.
  useEffect(() => {
    if (!editing) return
    const beat = window.setInterval(() => {
      vaultApi.lock(path).catch((error) => {
        if (error instanceof ApiError && error.code === 'locked') {
          setLockHolder(String(error.values.holder ?? ''))
          setEditingPath(null)
        }
      })
    }, HEARTBEAT)
    // The last words go out first, as a request that outlives the page; the lock is given back only after them.
    // A save that doubles one still under way is harmless: the server sees the same text and writes nothing.
    // A page that is going away runs no more code after this: then both requests leave at once (an unanswered lock
    // would run out by itself after 90 seconds anyway). When the editor itself goes, it has handed its last text to
    // `draft` already (NoteEditor's onLeave runs before this clean-up).
    // The server never refuses these words: changed on disk, or locked by somebody else meanwhile, they go into a
    // conflict copy. Then the vault is read again, so the copy shows up (and its banner on the note).
    const flush = (unloading: boolean) => {
      const text = unloading ? readDraft() : draft.current
      const pending = text !== saved.current
      const sent = pending
        ? vaultApi
            .save(path, text, base.current, true)
            .then((result) => {
              if (result.conflict) void reload()
            })
            .catch(() => undefined)
        : Promise.resolve()
      if (pending) saved.current = text
      const unlock = () => vaultApi.unlock(path, true).catch(() => undefined)
      if (unloading) void unlock()
      else void sent.finally(unlock)
    }
    const leave = () => flush(true)
    window.addEventListener('pagehide', leave)
    return () => {
      window.clearInterval(beat)
      window.removeEventListener('pagehide', leave)
      if (timer.current !== null) window.clearTimeout(timer.current)
      flush(false)
    }
  }, [editing, path, reload])

  // Changes made elsewhere: asked for every few seconds while the page is visible.
  useEffect(() => {
    if (!note || leaving) return
    const tick = async () => {
      if (document.visibilityState !== 'visible' || saving.current) return
      const state = await vaultApi.noteState(path).catch(() => null)
      if (!state || current.current !== path) return
      if (!editingNow.current) {
        if (state.hash !== note.hash) void load(path)
        else if ((state.lock?.holder ?? null) !== (note.lock?.holder ?? null)) setNote((known) => known && { ...known, lock: state.lock })
        return
      }
      // Own changes not yet saved: nothing is touched here, the next save becomes a conflict copy.
      if (state.hash === base.current || edits.current !== savedEdits.current || saving.current) return
      const fresh = await vaultApi.note(path).catch(() => null)
      if (!fresh || current.current !== path || !editingNow.current || edits.current !== savedEdits.current || saving.current) return
      editor.current?.replace(fresh.content)
      draft.current = fresh.content
      saved.current = fresh.content
      base.current = fresh.hash
      setNote(fresh)
      setSaveState('refreshed')
    }
    const every = window.setInterval(() => void tick(), POLL)
    return () => window.clearInterval(every)
  }, [path, note, load, leaving])

  const onChange = () => {
    edits.current += 1
    setSaveState('pending')
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void save(), SAVE_PAUSE)
  }

  const resolve = useMemo(() => {
    const map = new Map<string, string>()
    for (const link of links?.outgoing ?? []) if (link.path) map.set(link.target.toLowerCase(), link.path)
    return (target: string) => map.get(target.toLowerCase()) ?? null
  }, [links])
  const html = useMemo(() => (note ? renderMarkdown(note.content, resolve, note.path) : ''), [note, resolve])
  const outgoing = useMemo(() => distinctOutgoing(links?.outgoing ?? []), [links])
  useEnrich(article, html)
  // A space with a theme of its own: its colours under its notes (loaded once for all panes).
  const noteSpaceTheme = note && me?.appearance?.space_themes !== false ? (spaces.find((space) => space.name === note.path.split('/')[0])?.theme ?? '') : ''
  useEffect(() => {
    if (noteSpaceTheme) ensureSpaceTheme(noteSpaceTheme, async (ref) => (await themesApi.one(ref)).colours)
  }, [noteSpaceTheme])
  const copies = useMemo(() => copiesOf(path, siblings), [path, siblings])
  const view = note ? viewFor(plugins, note) : null
  const reveal = (heading: string, index: number) => {
    // Reading: the article; writing: the editor of this pane.
    const root = article.current ?? document.querySelector(`[data-pane="${side}"] .ProseMirror`)
    const found = [...(root?.querySelectorAll('h1, h2, h3, h4, h5, h6') ?? [])]
    const target = found.find((element) => element.textContent?.trim() === heading.trim()) ?? found[index]
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const pluginWrote = () => void load(path)
  // The note in front, for the quick switcher's headings after "#" (with what is typed in the editor).
  const revealNow = useRef(reveal)
  revealNow.current = reveal
  useEffect(() => {
    if (side !== 'left' || !note) return
    setShownNote({ path: note.path, read: () => (editingNow.current && editor.current ? editor.current.text() : note.content) })
    const jump = (event: Event) => {
      const { text, index } = (event as CustomEvent<{ text: string; index: number }>).detail
      revealNow.current(text, index)
    }
    window.addEventListener(HEADING_EVENT, jump)
    return () => {
      setShownNote(null)
      window.removeEventListener(HEADING_EVENT, jump)
    }
  }, [side, note])
  const originalPath = originalOf(path)

  const openFile = (file: string, newTab = false) => {
    if (newTab) window.open(fileRoute(file), '_blank', 'noopener')
    else navigate(fileRoute(file))
  }

  const openLink = async (target: string, newTab: boolean) => {
    let found: string | null
    try {
      found = await linkIdx.resolveNow(target)
    } catch {
      // Without an answer nothing is made: a link that may well lead somewhere must not become a new note.
      setProblem('internal_error')
      return
    }
    if (found) {
      if (newTab) openInTab(found, navigate)
      else open(found)
      return
    }
    // A file (`photo.png`, `doc.pdf`): the server knows where it is; a missing one is never made into a note.
    if (isFileTarget(target)) {
      const file = await vaultApi.resolve(path, target.split('#')[0].trim(), 'embed').catch(() => null)
      if (file?.path) openFile(file.path, newTab)
      else setNotice(t('note.missingFile', { name: target }))
      return
    }
    // A link to a note not written yet: like Obsidian, a click makes it next to this one and opens it for writing.
    // One into another space (`[[Homelab/Why ZFS]]`) makes it there, where the link looks for it.
    let folder = folderOf(path)
    let title = target.split('#')[0].split('/').pop()?.trim()
    const across = linkedSpace(target, spaces, path.split('/')[0])
    if (across) {
      if (across.role === 'read') {
        setNotice(t('note.missingAcross', { name: linkName(target), space: across.space }))
        return
      }
      const parts = across.rest.split('/')
      title = parts.pop()?.trim()
      folder = [across.space, ...parts].join('/')
    }
    if (!title) return
    try {
      const made = await vaultApi.create(folder, title)
      await reload()
      go(made.path, true)
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }

  const rename = async (name: string) => {
    const clean = name.trim()
    if (!clean || !note) return
    const destination = `${folderOf(note.path)}/${clean}.md`
    try {
      const moved = await vaultApi.move(note.path, destination)
      setRenaming(null)
      // Counts only notes the account may read: the server leaves out the others (they follow all the same).
      if (moved.rewritten > 0) afterOpen.current = t('note.linksFollowed', { count: moved.rewritten })
      await reload()
      open(moved.path)
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }

  const askToDelete = async () => {
    setOwn([])
    setWithOwn(true)
    setDeleting(true)
    const found = await vaultApi.own(path).catch(() => ({ paths: [] as string[] }))
    if (current.current === path) setOwn(found.paths)
  }

  const remove = async () => {
    if (!note) return
    setDeleting(false)
    setGone(note.path)
    try {
      await vaultApi.remove(note.path, withOwn ? own : [])
      await reload()
      // The right one closes; for the left one the note on the right (if any) comes into its place.
      if (side === 'right') navigate({ pathname: location.pathname, search: '' })
      else navigate(right && right !== note.path ? noteUrl(right) : '/')
    } catch (error) {
      setGone(null)
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }

  // Comparing while editing would let two saves race (the editor's and the comparison's): editing ends first.
  const compare = async (notePath: string, copyPath: string) => {
    if (editing && !(await stopEditing())) return
    setComparing({ note: notePath, copy: copyPath })
  }

  // The palette's commands for the note in front (the left one; the right one is only beside it).
  useCommands((): Command[] => {
    if (!note || side !== 'left' || mirror) return []
    const group = t('palette.note')
    const role = spaces.find((space) => space.name === note.path.split('/')[0])?.role ?? 'read'
    const mayWrite = role !== 'read'
    const locked = !!(lockHolder ?? (note.lock && !note.lock.mine ? note.lock.holder : null))
    const favorite = favorites.some((item) => item.path === note.path)
    const list: Command[] = [
      { id: 'note.inGraph', label: t('note.inGraph'), group, symbol: 'graph', run: () => navigate(`/?focus=${encodeURIComponent(note.path)}`) },
      { id: 'note.favorite', label: favorite ? t('note.favoriteRemove') : t('note.favoriteAdd'), group, symbol: 'star', run: () => void setFavorite(note.path, !favorite) },
      { id: 'note.copyLink', label: t('menu.copyLink'), group, symbol: 'link', run: () => void copyText(`[[${baseName(note.path).replace(/\.md$/i, '')}]]`) },
    ]
    if (editing) {
      list.unshift({ id: 'note.read', label: t('palette.stopEditing'), group, symbol: 'eye', run: () => void stopEditing() })
      list.push({ id: 'note.mode', label: mode === 'visual' ? t('note.sourceMode') : t('note.visualMode'), group, symbol: 'code', run: () => setMode(mode === 'visual' ? 'source' : 'visual') })
    } else if (mayWrite && !locked && !note.readonly) {
      list.unshift({ id: 'note.edit', label: t('palette.startEditing'), group, symbol: 'pencil', run: () => void startEditing() })
    }
    if (mayWrite && !editing) {
      list.push({ id: 'note.rename', label: t('note.rename'), group, symbol: 'move', run: () => setRenaming(baseName(note.path)) })
      if (!locked) list.push({ id: 'note.delete', label: t('note.delete'), group, symbol: 'trash', run: () => void askToDelete() })
    }
    if (role === 'manage' && me?.shares_allowed && !editing) list.push({ id: 'note.share', label: t('share.button'), group, symbol: 'globe', run: () => setSharing(true) })
    return list
  })
  const uploaded = (done: Uploaded[]) => {
    const removed = new Set(done.flatMap((item) => item.removed))
    const parts = [t('note.uploaded', { count: done.length })]
    if (removed.has('location') || removed.has('device') || removed.has('metadata')) parts.push(t('note.uploadedCleaned'))
    if (removed.has('unchecked')) parts.push(t('note.uploadedUnchecked'))
    if (done.some((item) => item.duplicate)) parts.push(t('note.uploadedDuplicate'))
    setInfo(parts.join(' '))
  }

  useEffect(() => {
    if (leaving || !path) return
    let live = true
    draftsApi.list(path).then(
      (found) => live && setDrafts(found),
      () => live && setDrafts([]),
    )
    return () => {
      live = false
    }
  }, [path, generation, leaving])

  const draftDone = async (result: { path: string | null; conflict: string | null }) => {
    setDraftShown(null)
    setDrafts(await draftsApi.list(path).catch(() => []))
    if (result.conflict) setConflict(result.conflict)
    await reload()
    void load(path)
  }

  const compared = async () => {
    const shown = comparing
    setComparing(null)
    setConflict(null)
    await reload()
    // The copy is gone now; standing on it, go to the note.
    if (shown && shown.copy === path) open(shown.note)
    else void load(path)
  }

  const paneClass = side === 'right' ? 'hidden min-w-0 flex-1 border-l border-ink-700/80 lg:flex' : 'flex min-w-0 flex-1'
  const closeRight = () => navigate({ pathname: location.pathname, search: '' })

  if (!note) {
    return (
      <>
        <main className={paneClass + ' flex-col'}>
          {side === 'left' && <TabBar path={path} />}
          <div className="flex flex-1 items-center justify-center px-6 text-center text-mist-500">
            {problem ? (problem === 'not_found' ? t('note.notFound') : errorText(problem)) : t('common.loading')}
          </div>
        </main>
      </>
    )
  }

  const showInGraph = () => navigate(`/?focus=${encodeURIComponent(note.path)}`)
  const cssClasses = noteClasses(note.front)
  const spaceTheme = me?.appearance?.space_themes !== false ? (spaces.find((space) => space.name === note.path.split('/')[0])?.theme ?? '') : ''
  const chain = note.path.split('/').slice(0, -1).map((name, index, all) => ({ id: all.slice(0, index + 1).join('/'), name }))
  const foreignLock = note.lock && !note.lock.mine ? note.lock.holder : null
  const lockedBy = lockHolder ?? foreignLock
  // The own right in the note's space: reading only hides every change; managing may share.
  const role = spaces.find((space) => space.name === note.path.split('/')[0])?.role ?? 'read'
  const mayWrite = role !== 'read'

  return (
    <>
      <main className={paneClass} data-pane={side} data-space-theme={spaceTheme || undefined}>
        <div className="flex min-w-0 flex-1 flex-col">
          {side === 'left' && <TabBar path={note.path} />}
          {/* Toolbar */}
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-ink-700/80 px-6 py-2.5">
            {side === 'right' && (
              <button type="button" onClick={closeRight} aria-label={t('note.closeRight')} title={t('note.closeRight')} className="rounded-full p-1 text-mist-500 hover:bg-ink-850 hover:text-mist-100">
                <Symbol name="close" className="h-4 w-4" />
              </button>
            )}
            <div className="min-w-0 flex-1 truncate text-sm text-mist-500">
              {chain.map((c, i) => (
                <span key={c.id}>
                  {i > 0 && <span className="px-1.5 text-mist-600">›</span>}
                  <span className={i === 0 ? 'font-medium text-mist-300' : ''}>{c.name}</span>
                </span>
              ))}
            </div>
            {editing && <SaveBadge state={saveState} />}
            <div className="flex items-center rounded-full border border-ink-700 bg-ink-850 p-0.5 text-sm" role="group" aria-label={t('note.view')}>
              <button
                type="button"
                onClick={() => editing && void stopEditing()}
                aria-pressed={!editing}
                className={'inline-flex items-center gap-1.5 rounded-full px-3 py-1 ' + (!editing ? 'bg-accent-500 font-semibold text-on-accent' : 'text-mist-400 hover:text-mist-100')}
              >
                <Symbol name="eye" className="h-3.5 w-3.5" /> {t('note.read')}
              </button>
              <button
                type="button"
                onClick={() => !editing && void startEditing()}
                aria-pressed={editing}
                disabled={!!lockedBy || note.readonly || !mayWrite || mirror}
                title={
                  mirror
                    ? t('note.mirror')
                    : !mayWrite
                    ? t('note.readOnlyRight')
                    : lockedBy
                      ? t('note.lockedTitle', { name: lockedBy })
                      : note.readonly
                        ? t('note.readonlyTitle')
                        : undefined
                }
                className={'inline-flex items-center gap-1.5 rounded-full px-3 py-1 disabled:cursor-not-allowed disabled:opacity-40 ' + (editing ? 'bg-accent-500 font-semibold text-on-accent' : 'text-mist-400 hover:text-mist-100')}
              >
                <Symbol name="pencil" className="h-3.5 w-3.5" /> {t('note.edit')}
              </button>
            </div>
            {!mayWrite && !mirror && !editing && (
              <button type="button" onClick={() => setProposing(true)} className="inline-flex items-center gap-1.5 rounded-full border border-accent-500/50 px-3 py-1 text-sm text-accent-300 hover:bg-accent-500/10">
                <Symbol name="pencil" className="h-3.5 w-3.5" /> {t('proposals.button')}
              </button>
            )}
            <Link to={`/?focus=${encodeURIComponent(note.path)}`} className="inline-flex items-center gap-1.5 rounded-full border border-ink-700 px-3 py-1 text-sm text-mist-300 hover:bg-ink-850">
              <Symbol name="graph" className="h-3.5 w-3.5" /> {t('note.inGraph')}
            </Link>
            {(() => {
              const favorite = favorites.some((item) => item.path === note.path)
              return (
                <button
                  type="button"
                  aria-pressed={favorite}
                  onClick={() => void setFavorite(note.path, !favorite)}
                  title={favorite ? t('note.favoriteRemove') : t('note.favoriteAdd')}
                  aria-label={t('note.favorite')}
                  className={'rounded-full border px-2 py-1 text-sm ' + (favorite ? 'border-warn-500/50 bg-warn-500/10 text-warn-500' : 'border-ink-700 text-mist-400 hover:bg-ink-850 hover:text-mist-100')}
                >
                  <Symbol name="star" className="h-4 w-4" />
                </button>
              )
            })()}
            {editing ? (
              <details ref={menu} className="relative">
                <summary className="cursor-pointer list-none rounded-full border border-ink-700 px-3 py-1 text-sm text-mist-300 hover:bg-ink-850" aria-label={t('note.menu')}>
                  ⋯
                </summary>
                <div className="absolute right-0 z-20 mt-1 w-52 rounded-xl border border-ink-700 bg-ink-900 p-1 shadow-xl">
                  <button
                    type="button"
                    onClick={(event) => {
                      setMode(mode === 'visual' ? 'source' : 'visual')
                      ;(event.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open')
                    }}
                    className="block w-full rounded-lg px-3 py-1.5 text-left text-sm text-mist-300 hover:bg-ink-850"
                  >
                    {mode === 'visual' ? t('note.sourceMode') : t('note.visualMode')}
                  </button>
                </div>
              </details>
            ) : (
              <>
                {role === 'manage' && me?.shares_allowed && (
                  <button type="button" onClick={() => setSharing(true)} className="inline-flex items-center gap-1.5 rounded-full border border-ink-700 px-3 py-1 text-sm text-mist-300 hover:bg-ink-850">
                    <Symbol name="globe" className="h-3.5 w-3.5" /> {t('share.button')}
                  </button>
                )}
                {mayWrite && (
                  <>
                    <button type="button" onClick={() => setRenaming(baseName(note.path))} className="rounded-full border border-ink-700 px-3 py-1 text-sm text-mist-300 hover:bg-ink-850">
                      {t('note.rename')}
                    </button>
                    <button type="button" onClick={() => void askToDelete()} disabled={!!lockedBy} className="rounded-full border border-ink-700 px-3 py-1 text-sm text-bad-500 hover:bg-ink-850 disabled:opacity-40">
                      {t('note.delete')}
                    </button>
                  </>
                )}
              </>
            )}
            {sharing && <ShareDialog path={note.path} folder={note.path.slice(0, note.path.lastIndexOf('/'))} onClose={() => setSharing(false)} />}
          </div>

          {/* Banners */}
          {changed && side === 'left' && (
            <Banner
              tone="info"
              symbol="info"
              action={
                <span className="flex gap-2">
                  {changed.since_version !== null && (
                    <button
                      type="button"
                      onClick={() => void vaultApi.version(changed.since_version!).then((old) => setComparing2({ kind: 'news', left: old.content }), () => setProblem('internal_error'))}
                      className="rounded-full border border-accent-500/40 px-3 py-0.5 hover:bg-accent-500/10"
                    >
                      {t('news.difference')}
                    </button>
                  )}
                  <CloseButton onClick={() => setChanged(null)} />
                </span>
              }
            >
              {changed.author ? t('news.bannerBy', { name: changed.author, when: formatDate(changed.changed_at) }) : t('news.bannerOutside', { when: formatDate(changed.changed_at) })}
            </Banner>
          )}
          {side === 'left' &&
            proposals.slice(0, 3).map((proposal) =>
              proposal.by === me?.name ? (
                <Banner key={proposal.id} tone="info" symbol="info" action={<button type="button" className="rounded-full border border-accent-500/40 px-3 py-0.5 hover:bg-accent-500/10" onClick={() => void proposalsApi.withdraw(proposal.id).then(() => setProposals((list) => list.filter((item) => item.id !== proposal.id)))}>{t('proposals.withdraw')}</button>}>
                  {t('proposals.waitingOwn')}
                </Banner>
              ) : (
                <Banner key={proposal.id} tone="info" symbol="info" action={<button type="button" className="rounded-full border border-accent-500/40 px-3 py-0.5 hover:bg-accent-500/10" onClick={() => setComparing2({ kind: 'proposal', proposal })}>{t('proposals.compare')}</button>}>
                  {proposal.message ? t('proposals.bannerWith', { name: proposal.by, message: proposal.message }) : t('proposals.banner', { name: proposal.by })}
                </Banner>
              ),
            )}
          {renaming !== null && (
            <form
              className="mx-6 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-ink-700 bg-ink-850 px-4 py-2.5 text-sm"
              onSubmit={(event) => {
                event.preventDefault()
                void rename(renaming)
              }}
            >
              <label htmlFor="rename" className="text-mist-400">{t('note.renameLabel')}</label>
              <input
                id="rename"
                autoFocus
                value={renaming}
                onChange={(event) => setRenaming(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setRenaming(null)
                }}
                className="h-8 min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-2 outline-none focus:border-accent-500" />
              <button type="submit" className="rounded-full bg-accent-500 px-3 py-1 font-semibold text-on-accent">{t('note.renameDo')}</button>
              <button type="button" onClick={() => setRenaming(null)} className="rounded-full px-3 py-1 text-mist-400 hover:text-mist-100">{t('common.cancel')}</button>
              <p className="w-full text-xs text-mist-500">{t('note.renameHint')}</p>
            </form>
          )}
          {lockedBy && <Banner tone="warn" symbol="lock">{t('note.lockedBanner', { name: lockedBy })}</Banner>}
          {drafts.length > 0 && (
            <Banner
              tone="info"
              symbol="info"
              action={
                <button type="button" onClick={() => setDraftShown(drafts[0].id)} className="rounded-full border border-ink-700 px-3 py-1 text-xs font-semibold hover:bg-ink-850">
                  {t('drafts.look')}
                </button>
              }
            >
              {t('drafts.banner', { name: drafts[0].key_name, when: formatDate(drafts[0].created_at) })}
              {drafts[0].reason ? ` „${drafts[0].reason}“` : ''}
              {drafts.length > 1 ? ` ${t('drafts.more', { count: drafts.length - 1 })}` : ''}
            </Banner>
          )}
          {conflict ? (
            <Banner tone="warn" symbol="alert" action={<CompareButton onClick={() => void compare(path, conflict)} />}>
              {t('note.conflict')}{' '}
              <button type="button" onClick={() => open(conflict)} className="font-semibold underline">{baseName(conflict)}</button>
            </Banner>
          ) : (
            copies.length > 0 && (
              <Banner tone="warn" symbol="alert" action={<CompareButton onClick={() => void compare(path, copies[0])} />}>
                {t('note.copyExists')}
              </Banner>
            )
          )}
          {originalPath && siblings.includes(originalPath) && (
            <Banner tone="warn" symbol="alert" action={<CompareButton onClick={() => void compare(originalPath, path)} />}>
              {t('note.isCopy', { name: baseName(originalPath) })}
            </Banner>
          )}
          {note.readonly && <Banner tone="warn" symbol="alert">{t('note.readonlyBanner')}</Banner>}
          {notice && <Banner tone="warn" symbol="alert">{notice}</Banner>}
          {info && <Banner tone="info" symbol="info" action={<CloseButton onClick={() => setInfo(null)} />}>{info}</Banner>}
          {problem && <Banner tone="bad" symbol="alert">{errorText(problem)}</Banner>}

          {/* Body */}
          <div ref={scroller} className="nn-scroll min-h-0 flex-1 overflow-y-auto">
            {/* Room on the left for the editor's grip beside each block (reading keeps the same place, so nothing jumps). */}
            <div className={'mx-auto px-6 py-6 md:pl-16 ' + cssClasses.join(' ')} style={{ maxWidth: cssClasses.includes('wide') ? 'none' : 'calc(var(--nn-width) + 5.5rem)' }} data-testid="note-body">
              <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-mist-500">
                <span>{t('note.changed', { when: formatDate(note.modified) })}</span>
                <span>·</span>
                <span className="font-mono text-[11px]">{note.path}</span>
                {note.tags.map((tag) => (
                  <span key={tag} className="rounded-full bg-accent-500/10 px-2 py-0.5 text-accent-400">#{tag}</span>
                ))}
              </div>
              {editing ? (
                <Suspense fallback={<p className="text-sm text-mist-500">{t('common.loading')}</p>}>
                <NoteEditor
                  key={note.path}
                  ref={editor}
                  path={note.path}
                  content={draft.current}
                  links={linkIdx}
                  mode={mode}
                  onChange={onChange}
                  onLeave={(text) => {
                    draft.current = text
                  }}
                  onOpenLink={(target, newTab) => void openLink(target, newTab)}
                  onSource={() => setMode('source')}
                  onNotice={setNotice}
                  onFileRefused={() => setNotice(t('note.fileRefused'))}
                  onUploaded={uploaded}
                  onUploadFailed={(code) => setNotice(errorText(code))}
                />
                </Suspense>
              ) : view && !showText ? (
                <>
                  <ViewSwitch plugin={view} showText={showText} onChange={setShowText} />
                  <PluginFrame plugin={view} place="view" note={note} onOpen={open} onWritten={pluginWrote} />
                </>
              ) : (
                <>
                {view && <ViewSwitch plugin={view} showText={showText} onChange={setShowText} />}
                <article
                  ref={article}
                  className="nn-prose"
                  onClick={(e) => {
                    const target = (e.target as HTMLElement).closest('a[data-note]')
                    if (target) open(target.getAttribute('data-note')!)
                    // A file's page inside the app, not a full page load.
                    const file = (e.target as HTMLElement).closest('a[data-file], a[href^="/file/"]')
                    if (file && !e.ctrlKey && !e.metaKey) {
                      e.preventDefault()
                      navigate(file.getAttribute('href')!)
                    }
                  }}
                  dangerouslySetInnerHTML={{ __html: html }}
                />
                <PluginBlocks plugins={plugins} article={article} html={html} note={note} onOpen={open} onWritten={pluginWrote} />
                <NoteEmbeds article={article} html={html} onOpen={open} />
                <BaseBlocks article={article} html={html} note={note.path} />
                </>
              )}
              {(!wide || split) && (
                <div className="mt-10 space-y-6">
                  <PluginPanels plugins={plugins} note={note} onOpen={open} onWritten={pluginWrote} onReveal={reveal} />
                  {!leaving && note.path === path && <LocalGraph path={note.path} generation={generation} onOpen={open} onShowInGraph={showInGraph} />}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right column */}
        {/* Two notes side by side: they need the room, the right column gives it. */}
        <aside className={'nn-scroll hidden w-80 shrink-0 overflow-y-auto border-l border-ink-700/80 px-4 py-4 ' + (split ? '' : 'xl:block')}>
          {wide && !split && (
            <div className="mb-5">
              {!leaving && note.path === path && <LocalGraph path={note.path} generation={generation} onOpen={open} onShowInGraph={showInGraph} />}
            </div>
          )}
          {note && (
            <div className="mb-5">
              <PluginPanels plugins={plugins} note={note} onOpen={open} onWritten={pluginWrote} onReveal={reveal} />
            </div>
          )}
          <Outline content={note.content} scroller={scroller} onReveal={reveal} />
          <Section symbol="backlink" title={t('note.backlinks')} count={links?.backlinks.length ?? 0}>
            {links?.backlinks.length === 0 && <p className="px-2 text-sm text-mist-600">{t('note.noBacklinks')}</p>}
            {links?.backlinks.map((item) => (
              <button key={item.path + item.line} type="button" data-note={item.path} onClick={() => open(item.path)} className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-ink-850">
                <span className="block text-sm font-medium text-mist-200">{item.title}</span>
                <span className="block truncate text-xs text-mist-500">{folderOf(item.path)}</span>
              </button>
            ))}
          </Section>
          <Section symbol="link" title={t('note.outgoing')} count={outgoing.length}>
            {outgoing.map(({ link: item, count }, index) => {
              const times = count > 1 && <span className="ml-auto shrink-0 text-xs text-mist-600 tabular-nums" aria-label={t('note.linkedTimes', { count })}>×{count}</span>
              return item.path ? (
                <button key={index} type="button" data-note={isNotePath(item.path!) ? item.path! : undefined} onClick={() => (isNotePath(item.path!) ? open(item.path!) : openFile(item.path!))} className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm text-mist-300 hover:bg-ink-850">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: folderColor(item.path) }} />
                  <span className="truncate">{item.title}</span>
                  {times}
                </button>
              ) : (
                <div key={index} className="flex items-center gap-2 px-2 py-1 text-sm text-mist-600" title={t('note.missingLink')}>
                  <span className="h-2 w-2 shrink-0 rounded-full border border-dashed border-mist-600" />
                  <span className="truncate">{linkName(item.target)}</span>
                  {times}
                </div>
              )
            })}
          </Section>
          <Versions path={note.path} disabled={editing || !!lockedBy || !mayWrite} onRestored={() => void Promise.all([load(note.path), reload()])} />
        </aside>
      </main>

      {comparing2?.kind === 'news' && (
        <CompareDialog
          title={t('news.compareTitle', { title: note.title })}
          left={{ label: t('news.before'), text: comparing2.left }}
          right={{ label: t('news.now'), text: note.content }}
          onClose={() => setComparing2(null)}
        />
      )}
      {comparing2?.kind === 'proposal' && (
        <CompareDialog
          title={t('proposals.compareTitle', { name: comparing2.proposal.by })}
          note={comparing2.proposal.message || undefined}
          left={{ label: t('drafts.now'), text: note.content }}
          right={{ label: t('proposals.proposed'), text: comparing2.proposal.content ?? '' }}
          problem={proposalProblem}
          onClose={() => {
            setComparing2(null)
            setProposalProblem(null)
          }}
          actions={
            mayWrite && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    const id = comparing2.proposal.id
                    void proposalsApi.decline(id).then(
                      () => {
                        setProposals((list) => list.filter((item) => item.id !== id))
                        setComparing2(null)
                      },
                      (error) => setProposalProblem(errorText(error instanceof ApiError ? error.code : 'internal_error')),
                    )
                  }}
                  className="rounded-full border border-ink-700 px-3 py-1 text-sm text-bad-500 hover:bg-ink-850"
                >
                  {t('proposals.decline')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const id = comparing2.proposal.id
                    void proposalsApi.take(id).then(
                      (taken) => {
                        setProposals((list) => list.filter((item) => item.id !== id))
                        setComparing2(null)
                        setInfo(taken.conflict ? t('proposals.takenConflict') : t('proposals.taken'))
                        void load(note.path)
                      },
                      (error) => setProposalProblem(errorText(error instanceof ApiError ? error.code : 'internal_error')),
                    )
                  }}
                  className="rounded-full bg-accent-500 px-3 py-1 text-sm font-semibold text-on-accent"
                >
                  {t('proposals.take')}
                </button>
              </>
            )
          }
        />
      )}
      {proposing && (
        <ProposeDialog
          path={note.path}
          title={note.title}
          content={note.content}
          baseHash={note.hash}
          onClose={() => setProposing(false)}
          onSent={() => {
            setProposing(false)
            setInfo(t('proposals.sent'))
            void proposalsApi.forNote(note.path).then(setProposals, () => {})
          }}
        />
      )}
      <ConfirmDialog
        open={deleting}
        title={t('note.deleteTitle', { title: note.title })}
        confirm={t('note.deleteDo')}
        onCancel={() => setDeleting(false)}
        onConfirm={() => void remove()}
      >
        {t('note.deleteText')}
        {own.length > 0 && (
          <div className="mt-3 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2">
            <label className="flex items-start gap-2 text-sm text-mist-200">
              <input type="checkbox" checked={withOwn} onChange={(event) => setWithOwn(event.target.checked)} className="mt-1 accent-accent-500" />
              <span>{t('note.deleteOwn', { count: own.length })}</span>
            </label>
            <ul className="mt-1 ml-6 max-h-32 overflow-y-auto text-xs text-mist-500">
              {own.map((file) => (
                <li key={file} className="truncate">{baseName(file)}</li>
              ))}
            </ul>
          </div>
        )}
      </ConfirmDialog>
      {draftShown !== null && <DraftCompare draftId={draftShown} onClose={() => setDraftShown(null)} onDone={(result) => void draftDone(result)} />}
      {comparing && <ConflictCompare notePath={comparing.note} copyPath={comparing.copy} onClose={() => setComparing(null)} onDone={() => void compared()} />}
    </>
  )
}

function CompareButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <button type="button" onClick={onClick} className="shrink-0 rounded-full border border-warn-500/40 px-3 py-0.5 text-xs font-semibold hover:bg-warn-500/10">
      {t('note.compare')}
    </button>
  )
}

function SaveBadge({ state }: { state: SaveState }) {
  const { t } = useTranslation()
  if (state === 'idle') return null
  const tone = state === 'failed' ? 'text-bad-500' : 'text-mist-500'
  return (
    <span className={'text-xs ' + tone} role="status">
      {t(`note.save.${state}`)}
    </span>
  )
}

const BANNER_TONES = {
  warn: 'border-warn-500/30 bg-warn-500/10 text-warn-500',
  bad: 'border-bad-500/30 bg-bad-500/10 text-bad-500',
  info: 'border-accent-500/30 bg-accent-500/10 text-accent-400',
}

function CloseButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <button type="button" onClick={onClick} aria-label={t('common.close')} className="shrink-0 rounded-full p-1 hover:bg-accent-500/10">
      <Symbol name="close" className="h-3.5 w-3.5" />
    </button>
  )
}

function Banner({ tone, symbol, action, children }: { tone: keyof typeof BANNER_TONES; symbol: 'lock' | 'alert' | 'info'; action?: ReactNode; children: ReactNode }) {
  return (
    <div className={'mx-6 mt-4 flex items-center gap-3 rounded-xl border px-4 py-2.5 text-sm ' + BANNER_TONES[tone]} role={tone === 'info' ? 'note' : 'alert'} aria-live={tone === 'info' ? 'polite' : undefined}>
      <Symbol name={symbol} />
      <span className="flex-1">{children}</span>
      {action}
    </div>
  )
}

/** The history of a note: every save a version, sessions folded together, old ones thinned out. */
function Versions({ path, disabled, onRestored }: { path: string; disabled: boolean; onRestored: () => void }) {
  const { t } = useTranslation()
  const [list, setList] = useState<VersionInfo[] | null>(null)
  const [shown, setShown] = useState<{ id: number; content: string } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    setList(null)
    setShown(null)
  }, [path])

  const load = async () => {
    try {
      setList(await vaultApi.versions(path))
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }

  const restore = async (id: number) => {
    try {
      await vaultApi.restoreVersion(id)
      setShown(null)
      await load()
      onRestored()
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }

  return (
    <Section symbol="history" title={t('note.versions')} count={list?.length ?? null}>
      {list === null ? (
        <button type="button" onClick={() => void load()} className="w-full rounded-lg px-2 py-1.5 text-left text-sm text-accent-400 hover:bg-ink-850">
          {t('note.showVersions')}
        </button>
      ) : (
        <ul className="space-y-0.5">
          {list.map((version, index) => (
            <li key={version.id} className="rounded-lg px-2 py-1.5 text-sm hover:bg-ink-850">
              <div className="flex items-center gap-2">
                <span className="flex-1 text-mist-300">{formatDate(version.updated_at)}</span>
                <span className="text-[11px] text-mist-600">{versionSource(version, t)}</span>
              </div>
              <div className="mt-0.5 flex gap-3 text-xs">
                <button
                  type="button"
                  onClick={async () => setShown(shown?.id === version.id ? null : { id: version.id, content: (await vaultApi.version(version.id)).content })}
                  className="text-mist-400 hover:text-mist-100"
                >
                  {shown?.id === version.id ? t('note.hideVersion') : t('note.showVersion')}
                </button>
                {index > 0 && (
                  <button type="button" disabled={disabled} onClick={() => void restore(version.id)} className="text-accent-400 hover:text-accent-300 disabled:opacity-40">
                    {t('note.restoreVersion')}
                  </button>
                )}
              </div>
              {shown?.id === version.id && (
                <pre className="nn-scroll mt-2 max-h-64 overflow-auto rounded-lg border border-ink-700 bg-ink-900 p-2 text-[11px] whitespace-pre-wrap text-mist-300">{shown.content}</pre>
              )}
            </li>
          ))}
        </ul>
      )}
      {problem && <p className="px-2 text-xs text-bad-500">{errorText(problem)}</p>}
    </Section>
  )
}

function Section({ symbol, title, count, children }: { symbol: 'backlink' | 'link' | 'history'; title: string; count: number | null; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-2 flex items-center gap-2 px-2 text-[11px] font-semibold tracking-wider text-mist-500 uppercase">
        <Symbol name={symbol} className="h-3.5 w-3.5" />
        {title}
        {count !== null && <span className="ml-auto text-mist-600 tabular-nums">{count}</span>}
      </h3>
      {children}
    </section>
  )
}
