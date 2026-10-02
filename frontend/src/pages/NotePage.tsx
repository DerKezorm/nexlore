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

import { dailyDayOf, dayOfName } from '../lib/dayname'
import { addDays, today as isoToday } from '../lib/everyday'
import { taskLines } from '../lib/taskLines'
import { ApiError, draftsApi, everydayApi, vaultApi, type DraftInfo, type Links, type NoteData, type Uploaded, type VersionInfo, recentApi, themesApi, proposalsApi, type NoteNews, type Proposal, commentsApi, type Thread } from '../api/client'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { ConflictCompare } from '../components/ConflictCompare'
import { DraftCompare } from '../components/DraftCompare'
import type { EditorHandle, EditorMode } from '../components/NoteEditor'
import { Sidebar } from '../components/Sidebar'
import { Symbol, type SymbolName } from '../components/Symbol'
import { NotePanel, type PanelPart } from '../components/NotePanel'
import { ImageViewer } from '../components/ImageViewer'
import { Presence } from '../components/Presence'
import { WordCount } from '../components/WordCount'
import { usePresence } from '../lib/presence'
import { picturesIn, type Picture } from '../lib/pictures'
import { Comments } from '../components/Comments'
import { CommentLayer } from '../components/CommentLayer'
import { FoldLayer } from '../components/FoldLayer'
import { MergeDialog } from '../components/MergeDialog'
import { askFoldAll } from '../lib/folds'
import { revealThread, type Anchor } from '../lib/comments'
import { Unlinked } from '../components/Unlinked'
import { NoteStart } from '../components/NoteStart'
import { Outline } from '../components/Outline'
import { CompareDialog } from '../components/CompareDialog'
import { BaseBlocks } from '../components/BaseBlocks'
import { ProposeDialog } from '../components/ProposeDialog'
import { seenNote } from '../lib/news'
import { useEnrich } from '../lib/enrich'
import { noteClasses, type PanelTab } from '../lib/appearance'
import { backlinkNotes } from '../lib/backlinks'
import { ensureSpaceTheme } from '../lib/themes'
import { TabBar } from '../components/TabBar'
import { openInTab } from '../lib/tabs'
import { copiesOf, originalOf } from '../lib/compare'
import { errorText } from '../lib/errors'
import { isFileTarget, isNotePath } from '../lib/files'
import { distinctOutgoing, LinkIndex, linkedSpace, linkName } from '../lib/links'
import { fileRoute, formatDate, renderMarkdown, withoutFrontMatter } from '../lib/markdown'
import { baseName, decodedOrNull, folderOf, noteUrl } from '../lib/vault'
import { versionSource } from '../lib/versions'
import { announceLeaving, askVaultAction, copyText, LEAVING_EVENT, within, type Leaving } from '../lib/vaultActions'
import { useCommands, type Command } from '../lib/commands'
import { askFolder, HEADING_EVENT, PANEL_EVENT, RECENT_EVENT, setShownNote } from '../lib/shell'
import { usePeople } from '../lib/people'
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
// The properties table brings the YAML reader: loaded with the first note that has properties.
const Properties = lazy(() => import('../components/Properties').then((module) => ({ default: module.Properties })))

const SAVE_PAUSE = 1200
const HEARTBEAT = 30_000
const POLL = 5_000

/** Whether the window matches a media query, following it as it changes. */
function useMedia(query: string, fallback: boolean): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? fallback)
  useEffect(() => {
    const list = window.matchMedia?.(query)
    if (!list) return
    const update = () => setMatches(list.matches)
    update()
    list.addEventListener('change', update)
    return () => list.removeEventListener('change', update)
  }, [query])
  return matches
}

type MenuEntry = 'separator' | { label: string; symbol: SymbolName; run: () => void; danger?: boolean; disabled?: boolean; keys?: string }

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'failed' | 'refreshed'

/**
 * The notes page: the sidebar, the note, and on request a second note beside it (`?right=`, from the menu "Open to
 * the right"). Each note is a pane of its own with everything a note has; the right one changes only `right` when a
 * link in it is followed. On a narrow screen only the left one shows.
 */

/** The search page for a tag (and the tags below it). */
const tagSearch = (tag: string) => `/search?q=${encodeURIComponent('tag:' + tag)}`

/** The heading a link's part asks for (`[[Note#Part#Subpart]]` means the subpart); none for a block (`#^id`). */
function headingOf(section: string): string {
  const last = section.split('#').pop()?.trim() ?? ''
  return last.startsWith('^') ? '' : last
}

/** The part after `#` of what a link says (`Note#Heading|Shown`), as the editor hands it over. */
function sectionOf(target: string): string {
  const inner = target.split('|')[0]
  const at = inner.indexOf('#')
  return at < 0 ? '' : inner.slice(at + 1).trim()
}

/** Headings compare as link targets do: case and runs of spaces do not count. */
const sameHeading = (a: string, b: string) => {
  const fold = (text: string) => text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()
  return fold(a) === fold(b)
}

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
  const nameOf = usePeople()
  const { reload, spaces, generation, favorites, setFavorite } = useStore()
  const { me, setAppearance } = useAuth()
  const navigate = useNavigate()
  const [sharing, setSharing] = useState(false)
  // A picture of the note over the whole page (the note's pictures, and which one first).
  const [viewing, setViewing] = useState<{ pictures: Picture[]; start: number } | null>(null)
  // The column beside the note from 1280 pixels on (shown or hidden with the account); below, a sheet on request,
  // on a phone from below. Two notes side by side need the room: then a sheet as well.
  const wide = useMedia('(min-width: 1280px)', true)
  const phone = useMedia('(max-width: 767.98px)', false)
  const inline = wide && !split
  const [sheetOpen, setSheetOpen] = useState(false)
  useEffect(() => setSheetOpen(false), [path])
  const panelTab = me?.appearance?.panel_tab ?? 'links'
  const panelShown = inline ? me?.appearance?.panel !== false : sheetOpen
  const togglePanel = useCallback(() => {
    if (inline) void setAppearance({ panel: !panelShown }).catch(() => {})
    else setSheetOpen((open) => !open)
  }, [inline, panelShown, setAppearance])
  useEffect(() => {
    if (side !== 'left') return
    window.addEventListener(PANEL_EVENT, togglePanel)
    return () => window.removeEventListener(PANEL_EVENT, togglePanel)
  }, [side, togglePanel])

  const [note, setNote] = useState<NoteData | null>(null)
  const [links, setLinks] = useState<Links | null>(null)
  // Comments in the margin: the note's threads, a new one asked for from words in the text, and which are found.
  const [threads, setThreads] = useState<Thread[] | null>(null)
  const commentsMark = useRef<string | null>(null)
  const [commentDraft, setCommentDraft] = useState<Anchor | null>(null)
  const [commentsFound, setCommentsFound] = useState<Set<number> | undefined>(undefined)
  const [threadFocus, setThreadFocus] = useState<{ id: number; ask: number } | null>(null)
  // Merging this note into another (components/MergeDialog.tsx).
  const [merging, setMerging] = useState(false)
  useEffect(() => {
    setThreads(null)
    setCommentDraft(null)
  }, [path])
  const notePath = note?.path
  useEffect(() => {
    if (!notePath) return
    let alive = true
    commentsApi.list(notePath).then(
      (found) => alive && setThreads(found.threads),
      () => alive && setThreads([]),
    )
    return () => {
      alive = false
    }
  }, [notePath])
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
  // The note's text as shown, for the word count under it.
  const body = useRef<HTMLDivElement>(null)
  // Who else has the note open (the left note only: the right one is a look aside).
  const present = usePresence(side === 'left' && path && !leaving ? path : null, editing)
  const [mode, setMode] = useState<EditorMode>('visual')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  /** Why the last save failed (an error code, `offline` without an answer), and how often in a row. */
  const [saveProblem, setSaveProblem] = useState<{ code: string; count: number } | null>(null)
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
  // The question for them, still on its way when the trash is confirmed at once: the deletion waits for it, or the
  // files would stay behind and the late question would ask after a note already gone (404).
  const ownAsked = useRef<Promise<string[]> | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // When this tab last saved the note: the line under the title says so at once (it kept an older time, P6.20).
  const [savedAt, setSavedAt] = useState<number | null>(null)
  // A daily note made without its template (the space's template is gone): said once, when it opens.
  const templateMissing = useRef(false)
  templateMissing.current = (location.state as { templateMissing?: boolean } | null)?.templateMissing === true
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

  /**
   * Where a note opens from this pane: the right pane changes only `right`; the left one keeps the right note.
   * `section`: the part a link asks for; the left pane scrolls to its heading (`#Heading` in the address).
   */
  const go = useCallback(
    (next: string, edit = false, section = '') => {
      if (side === 'right') {
        navigate({ pathname: location.pathname, search: `?right=${encodeURIComponent(next)}` })
        return
      }
      const query = new URLSearchParams()
      if (right) query.set('right', right)
      if (edit) query.set('edit', '1')
      const search = query.toString()
      const heading = headingOf(section)
      navigate(noteUrl(next) + (search ? `?${search}` : '') + (heading ? `#${encodeURIComponent(heading)}` : ''))
    },
    [side, right, navigate, location.pathname],
  )
  // A part of the note in front (`[[#Heading]]`): scrolled to at once, nothing to load.
  const revealHere = useRef<(heading: string) => void>(() => undefined)
  const open = useCallback(
    (next: string, section = '') => {
      const heading = headingOf(section)
      if (heading && next === current.current) return revealHere.current(heading)
      go(next, false, section)
    },
    [go],
  )

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
            window.dispatchEvent(new CustomEvent(RECENT_EVENT))
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
      setSavedAt(Date.now())
      setSaveProblem(null)
      setSaveState(edits.current === mark ? 'saved' : 'pending')
      return 'saved'
    } catch (error) {
      setSaveState('failed')
      // A text over the server's limit comes back as an invalid field `content`: said as what it is.
      const tooLarge = error instanceof ApiError && (error.code === 'too_large' || (error.code === 'invalid_input' && (error.values.fields as string[] | undefined)?.includes('content')))
      const code = tooLarge ? 'too_large' : error instanceof ApiError ? error.code : 'offline'
      setSaveProblem((before) => ({ code, count: (before?.count ?? 0) + 1 }))
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

  // Ctrl+S while editing saves at once instead of opening the browser's "save page as" (nexlore saves by itself).
  useEffect(() => {
    if (!editing) return
    const key = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [editing, save])

  // A failed save is tried again by itself: soon when the network was gone (and at once when it is back), slowly when
  // the right to write was taken (it may come back), not at all for a text too large (it would fail again).
  useEffect(() => {
    if (!editing || saveState !== 'failed' || !saveProblem || saveProblem.code === 'too_large') return
    const base = saveProblem.code === 'forbidden' ? 30_000 : 5_000
    const wait = Math.min(60_000, base * 2 ** Math.min(saveProblem.count - 1, 4))
    const again = () => void save()
    const timer = window.setTimeout(again, wait)
    window.addEventListener('online', again)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('online', again)
    }
  }, [editing, saveState, saveProblem, save])

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
    setSavedAt(null)
    commentsMark.current = null
    setNotice(templateMissing.current ? t('today.templateMissing') : null)
    // A message meant for the note just opened (after a rename: how many notes had their links updated).
    setInfo(afterOpen.current)
    afterOpen.current = null
    setSaveState('idle')
    if (path) void load(path)
    // Only a new note says it again, not a new language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // Already before the page unloads: under the service worker the unlock sent from `pagehide` never arrived (the
    // note stayed locked for others for 90 seconds, measured). `pagehide` stays for phones; the second call finds
    // nothing left to save and only unlocks again.
    window.addEventListener('beforeunload', leave)
    window.addEventListener('pagehide', leave)
    return () => {
      window.clearInterval(beat)
      window.removeEventListener('beforeunload', leave)
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
      const state = await vaultApi.noteState(path).catch((problem: unknown) => (problem instanceof ApiError && problem.status === 404 ? 'gone' : null))
      if (current.current !== path) return
      if (state === 'gone') {
        // The note went away, or the right to read it (taken out of the space): say so, and let the sidebar
        // forget the space, instead of showing on and asking in vain every few seconds. Unsaved edits stay open.
        if (!editingNow.current) void Promise.all([reload(), load(path)])
        return
      }
      if (!state) return
      // New, changed or resolved comments of others show without a reload (they waited for one, P6.4).
      if (state.comments !== undefined) {
        // The first answer too: a comment made between loading the page and this answer would wait otherwise.
        if (commentsMark.current !== state.comments) {
          void commentsApi.list(path).then((found) => current.current === path && setThreads(found.threads), () => undefined)
        }
        commentsMark.current = state.comments
      }
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
  }, [path, note, load, leaving, reload])

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
  // The front matter as written, for the properties while reading.
  const readingHead = useMemo(() => (note ? note.content.slice(0, note.content.length - withoutFrontMatter(note.content).length) : ''), [note])
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
    const target = found.find((element) => sameHeading(element.textContent ?? '', heading)) ?? found[index]
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const pluginWrote = () => void load(path)
  // The note in front, for the quick switcher's headings after "#" (with what is typed in the editor).
  const revealNow = useRef(reveal)
  revealNow.current = reveal
  revealHere.current = (heading) => revealNow.current(heading, -1)
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
  // A heading asked for in the address (a favorite of it, `#Heading`): scrolled to once the note is drawn, once.
  const wantedHeading = useRef<string | null>(null)
  useEffect(() => {
    // A hand-made address with a broken escape (`#%zz`) is ignored: decoding it threw and emptied the whole page.
    wantedHeading.current = side === 'left' && location.hash ? decodedOrNull(location.hash.slice(1)) : null
  }, [side, location.hash, path])
  useEffect(() => {
    const heading = wantedHeading.current
    if (!heading || !note) return
    const frame = requestAnimationFrame(() => {
      revealNow.current(heading, -1)
      wantedHeading.current = null
    })
    return () => cancelAnimationFrame(frame)
  }, [html, note])
  const originalPath = originalOf(path)

  const openFile = (file: string, newTab = false) => {
    if (newTab) window.open(fileRoute(file), '_blank', 'noopener')
    else navigate(fileRoute(file))
  }

  const openLink = async (target: string, newTab: boolean) => {
    // `[[#Heading]]` in the editor: a part of this very note.
    if (target.trim().startsWith('#')) return void open(path, sectionOf(target))
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
      else open(found, sectionOf(target))
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
    // `[[2026-10-02]]` (what @tomorrow writes, as the space names its days) is that day's daily note: made where
    // the calendar makes it, not here.
    const daySpace = across ? across.space : path.split('/')[0]
    // The space's pattern from the server when the spaces have not come yet: a click right after loading made a
    // plain note beside this one instead of the daily note (seen on the slower CI machine).
    let format = spaces.find((item) => item.name === daySpace)?.daily_format
    if (format === undefined) format = await everydayApi.options(daySpace).then((options) => options.daily_format, () => undefined)
    const day = dayOfName(format, target.split('#')[0].split('/').pop() ?? '')
    if (day) {
      try {
        const made = await everydayApi.daily(daySpace, day)
        await reload()
        go(made.path, made.created)
      } catch (error) {
        setProblem(error instanceof ApiError ? error.code : 'internal_error')
      }
      return
    }
    try {
      const made = await vaultApi.create(folder, title)
      await reload()
      go(made.path, true)
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }

  // A daily note steps to the day before and after (P5.24): opened, or made from the template as the calendar makes it.
  const noteSpace = spaces.find((item) => item.name === path.split('/')[0])
  const thisDay = noteSpace ? dailyDayOf(path, noteSpace.daily_folder ?? 'Daily', noteSpace.daily_format) : null
  const stepDay = async (by: number) => {
    if (!thisDay || !noteSpace) return
    try {
      const made = await everydayApi.daily(noteSpace.name, addDays(thisDay, by))
      if (made.created) await reload()
      go(made.path, made.created)
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }

  // From a line of the search page (`?hit=words&near=start of the line`): the place shown and the words marked (P4.8).
  const hit = params.get('hit')
  const near = params.get('near')
  useEffect(() => {
    const root = article.current
    if (!root || !hit || editing) return
    const frame = requestAnimationFrame(() => {
      const fold = (text: string) => text.toLocaleLowerCase().replace(/\s+/g, ' ')
      const blocks = [...root.querySelectorAll<HTMLElement>('p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre')]
      const wanted = fold(near ?? '').slice(0, 40)
      const block =
        (wanted && blocks.find((item) => fold(item.textContent ?? '').includes(wanted))) ||
        blocks.find((item) => fold(item.textContent ?? '').includes(fold(hit)))
      if (!block) return
      markIn(block, hit)
      block.scrollIntoView({ block: 'center' })
    })
    return () => cancelAnimationFrame(frame)
  }, [html, hit, near, editing])

  // The boxes of the reading view know their line (in the order `taskLines` counts them); a writer may tick them.
  useEffect(() => {
    const root = article.current
    if (!root || !note || editing) return
    const writable = spaces.find((space) => space.name === note.path.split('/')[0])?.role !== 'read'
    const boxes = [...root.querySelectorAll<HTMLInputElement>('li > input[type="checkbox"], li > p > input[type="checkbox"]')].filter(
      (box) => !box.closest('.nn-embed-note, .nn-embed-block, .nn-embedded'),
    )
    boxes.forEach((box, index) => {
      box.dataset.task = String(index)
      box.disabled = !writable
    })
    // Tags are links for the keyboard too.
    root.querySelectorAll<HTMLElement>('.nn-tag[data-tag]').forEach((tag) => {
      tag.setAttribute('role', 'link')
      tag.tabIndex = 0
    })
  }, [html, note, editing, spaces])
  const tickInReading = async (box: HTMLInputElement) => {
    if (!note) return
    const found = taskLines(note.content)[Number(box.dataset.task)]
    if (!found) {
      box.checked = !box.checked
      return
    }
    box.disabled = true
    try {
      const result = await everydayApi.toggle({ path: note.path, line: found.line, raw: found.raw, file_hash: note.hash }, box.checked, isoToday())
      setNotice(result.conflict ? t('tasks.conflict') : result.recurrence_unknown ? t('tasks.recurrenceUnknown') : null)
      await load(note.path)
    } catch (error) {
      box.checked = !box.checked
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    } finally {
      box.disabled = false
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
    const asked = vaultApi.own(path).then((found) => found.paths, () => [] as string[])
    ownAsked.current = asked
    const found = await asked
    if (current.current === path) setOwn(found)
  }

  const remove = async () => {
    if (!note) return
    setDeleting(false)
    const along = withOwn ? await (ownAsked.current ?? Promise.resolve(own)) : []
    setGone(note.path)
    try {
      await vaultApi.remove(note.path, along)
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
      list.push({ id: 'note.rename', label: t('note.rename'), group, symbol: 'pencil', keys: 'F2', run: () => setRenaming(baseName(note.path)) })
      list.push({ id: 'note.move', label: t('menu.move'), group, symbol: 'move', run: () => askVaultAction({ kind: 'move', path: note.path, folder: false }) })
      if (!locked) list.push({ id: 'note.delete', label: t('note.trash'), group, symbol: 'trash', run: () => void askToDelete() })
    }
    if (role === 'manage' && me?.shares_allowed && !editing) list.push({ id: 'note.share', label: t('share.button'), group, symbol: 'globe', run: () => setSharing(true) })
    list.push({ id: 'note.panel', label: t('panel.toggle'), group, symbol: 'panel', keys: 'Alt+R', run: togglePanel })
    list.push({ id: 'note.foldAll', label: t('folds.foldAll'), group, symbol: 'chevronRight', run: () => askFoldAll(note.path, true) })
    list.push({ id: 'note.unfoldAll', label: t('folds.unfoldAll'), group, symbol: 'chevronDown', run: () => askFoldAll(note.path, false) })
    return list
  })
  // F2 renames the note in front, as in a file manager: its name above the text turns into a field.
  useEffect(() => {
    if (!note || side !== 'left' || mirror || editing) return
    const role = spaces.find((space) => space.name === note.path.split('/')[0])?.role ?? 'read'
    const locked = !!(lockHolder ?? (note.lock && !note.lock.mine ? note.lock.holder : null))
    if (role === 'read' || locked) return
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key !== 'F2' || event.ctrlKey || event.altKey || event.metaKey || target?.closest('input, textarea, [contenteditable="true"]')) return
      event.preventDefault()
      setRenaming(baseName(note.path))
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [note, side, mirror, editing, spaces, lockHolder])
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
        {/* The same nesting as below: the row of tabs stays mounted while the next note loads (a menu open on it
            stayed open, and a tab's state stays). */}
        <main className={paneClass}>
          <div className="flex min-w-0 flex-1 flex-col">
            {side === 'left' && <TabBar path={path} />}
            <div className="flex flex-1 items-center justify-center px-6 text-center text-mist-500">
              {problem ? (problem === 'not_found' ? t('note.notFound') : errorText(problem)) : t('common.loading')}
            </div>
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
  const lockedName = nameOf(lockedBy)
  // The own right in the note's space: reading only hides every change; managing may share.
  const role = spaces.find((space) => space.name === note.path.split('/')[0])?.role ?? 'read'
  const mayWrite = role !== 'read'
  const mayRename = mayWrite && !editing && !mirror && !lockedBy

  const showPanel = (tab: PanelTab) => {
    void setAppearance(inline && !panelShown ? { panel: true, panel_tab: tab } : { panel_tab: tab }).catch(() => {})
    if (!inline) setSheetOpen(true)
  }
  const closePanel = () => (inline ? void setAppearance({ panel: false }).catch(() => {}) : setSheetOpen(false))

  // "More": what a note needs now and then; the trash last, apart.
  const menuItems: MenuEntry[] = [
    { label: t('note.inGraph'), symbol: 'graph', run: showInGraph },
    { label: t('menu.copyLink'), symbol: 'link', run: () => void copyText(`[[${baseName(note.path)}]]`) },
    ...(role === 'manage' && me?.shares_allowed && !editing ? [{ label: t('share.button'), symbol: 'globe' as const, run: () => setSharing(true) }] : []),
    { label: t('note.versions'), symbol: 'history', run: () => showPanel('versions') },
    ...(editing ? [{ label: mode === 'visual' ? t('note.sourceMode') : t('note.visualMode'), symbol: 'code' as const, run: () => setMode(mode === 'visual' ? 'source' : 'visual') }] : []),
  ]
  if (mayWrite && !editing && !mirror) {
    menuItems.push(
      'separator',
      { label: t('note.rename'), symbol: 'pencil', keys: 'F2', disabled: !mayRename, run: () => setRenaming(baseName(note.path)) },
      { label: t('menu.move'), symbol: 'move', disabled: !!lockedBy, run: () => askVaultAction({ kind: 'move', path: note.path, folder: false }) },
      { label: t('merge.menu'), symbol: 'columns', disabled: !!lockedBy, run: () => setMerging(true) },
      'separator',
      { label: t('note.trash'), symbol: 'trash', danger: true, disabled: !!lockedBy, run: () => void askToDelete() },
    )
  }

  const loadThreads = (target: string) =>
    void commentsApi.list(target).then(
      (found) => current.current === target && setThreads(found.threads),
      () => current.current === target && setThreads([]),
    )
  const backNotes = backlinkNotes(links?.backlinks ?? [])
  const panelParts: PanelPart[] = [
    { id: 'outline', label: t('outline.title'), content: () => <Outline path={note.path} content={note.content} scroller={scroller} onReveal={reveal} /> },
    {
      id: 'links',
      label: t('panel.links'),
      count: backNotes.length,
      content: () => (
        <>
          <Section symbol="backlink" title={t('note.backlinks')} count={backNotes.length}>
            {backNotes.length === 0 && <p className="px-2 text-sm text-mist-600">{t('note.noBacklinks')}</p>}
            {backNotes.map((item) => (
              <button key={item.path} type="button" data-note={item.path} onClick={() => open(item.path)} className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-ink-850">
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 text-sm font-medium text-mist-200">{item.title}</span>
                  {item.count > 1 && (
                    <span className="shrink-0 text-xs text-mist-600 tabular-nums" title={t('note.linksFromThere', { count: item.count })}>
                      ×{item.count}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 line-clamp-2 block text-xs text-mist-500">{item.context ?? folderOf(item.path)}</span>
              </button>
            ))}
          </Section>
          <Unlinked
            path={note.path}
            onOpen={open}
            onLinked={() => {
              const at = note.path
              vaultApi.links(at).then((found) => current.current === at && setLinks(found), () => {})
            }}
          />
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
        </>
      ),
    },
    {
      id: 'comments',
      label: t('comments.title'),
      count: threads ? threads.filter((thread) => !thread.resolved).length : null,
      content: () => (
        <Comments
          path={note.path}
          threads={threads}
          draft={commentDraft}
          onDraftDone={() => setCommentDraft(null)}
          found={editing ? undefined : commentsFound}
          onReveal={(thread) => void (editing ? editor.current?.revealComment(thread.id) : revealThread(article.current, thread))}
          onChanged={() => loadThreads(note.path)}
          manage={role === 'manage'}
          focus={threadFocus}
        />
      ),
    },
    { id: 'graph', label: t('panel.graph'), content: () => (!leaving && note.path === path ? <LocalGraph path={note.path} generation={generation} onOpen={open} onShowInGraph={showInGraph} /> : null) },
    {
      id: 'versions',
      label: t('note.versions'),
      content: () => (
        <Versions
          path={note.path}
          disabled={editing || !!lockedBy || !mayWrite}
          why={!mayWrite ? t('note.readOnlyRight') : editing ? t('note.versionsWhileEditing') : lockedBy ? t('note.lockedTitle', { name: lockedName }) : null}
          onRestored={() => void Promise.all([load(note.path), reload()])}
        />
      ),
    },
    ...(plugins.some((plugin) => plugin.place.panel)
      ? [{ id: 'plugins' as const, label: t('panel.plugins'), content: () => <PluginPanels plugins={plugins} note={note} onOpen={open} onWritten={pluginWrote} onReveal={reveal} /> }]
      : []),
  ]

  return (
    <>
      <main className={paneClass} data-pane={side} data-space-theme={spaceTheme || undefined}>
        <div className="flex min-w-0 flex-1 flex-col">
          {side === 'left' && <TabBar path={note.path} />}
          {/* Toolbar: where the note lies, reading or editing, the star, everything rarer under "More", the column. */}
          <div className="flex shrink-0 items-center gap-1.5 border-b border-ink-700/80 px-3 py-2 sm:gap-2 sm:px-6" data-testid="note-toolbar">
            {side === 'right' && (
              <button type="button" onClick={closeRight} aria-label={t('note.closeRight')} title={t('note.closeRight')} className="rounded-full p-1 text-mist-500 hover:bg-ink-850 hover:text-mist-100">
                <Symbol name="close" className="h-4 w-4" />
              </button>
            )}
            <nav aria-label={t('note.path')} className="flex min-w-24 flex-1 items-center overflow-hidden text-sm text-mist-500" data-testid="note-crumbs">
              {chain.map((c, i) => (
                <span key={c.id} className={'flex items-center ' + (i === 0 ? 'shrink-0' : 'min-w-0')}>
                  {i > 0 && <span aria-hidden="true" className="px-1 text-mist-600">›</span>}
                  <button
                    type="button"
                    onClick={() => askFolder(c.id)}
                    title={c.id}
                    className={'max-w-full min-w-[2.75rem] truncate rounded-md px-1.5 py-0.5 hover:bg-ink-850 hover:text-mist-100 ' + (i === 0 ? 'font-medium text-mist-300' : '')}
                  >
                    {c.name}
                  </button>
                </span>
              ))}
            </nav>
            {side === 'left' && <Presence people={present} />}
            {editing && <SaveBadge state={saveState} problem={saveState === 'failed' ? (saveProblem?.code ?? null) : null} onRetry={() => void save()} />}
            <div className="flex shrink-0 items-center rounded-full border border-ink-700 bg-ink-850 p-0.5 text-sm" role="group" aria-label={t('note.view')}>
              <button
                type="button"
                onClick={() => editing && void stopEditing()}
                aria-pressed={!editing}
                aria-label={t('note.read')}
                className={'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 sm:px-3 ' + (!editing ? 'bg-accent-500 font-semibold text-on-accent' : 'text-mist-400 hover:text-mist-100')}
              >
                <Symbol name="eye" className="h-3.5 w-3.5" /> <span className="hidden sm:inline">{t('note.read')}</span>
              </button>
              <button
                type="button"
                onClick={() => !editing && void startEditing()}
                aria-pressed={editing}
                aria-label={t('note.edit')}
                disabled={!!lockedBy || note.readonly || !mayWrite || mirror}
                title={
                  mirror
                    ? t('note.mirror')
                    : !mayWrite
                    ? t('note.readOnlyRight')
                    : lockedBy
                      ? (note.lock?.own ? t('note.lockedOwnTitle') : t('note.lockedTitle', { name: lockedName }))
                      : note.readonly
                        ? t('note.readonlyTitle')
                        : undefined
                }
                className={'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 disabled:cursor-not-allowed disabled:opacity-40 sm:px-3 ' + (editing ? 'bg-accent-500 font-semibold text-on-accent' : 'text-mist-400 hover:text-mist-100')}
              >
                <Symbol name="pencil" className="h-3.5 w-3.5" /> <span className="hidden sm:inline">{t('note.edit')}</span>
              </button>
            </div>
            {!mayWrite && !mirror && !editing && (
              <button type="button" onClick={() => setProposing(true)} aria-label={t('proposals.button')} className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-accent-500/50 px-2.5 py-1 text-sm text-accent-300 hover:bg-accent-500/10 sm:px-3">
                <Symbol name="pencil" className="h-3.5 w-3.5" /> <span className="hidden sm:inline">{t('proposals.button')}</span>
              </button>
            )}
            {(() => {
              const favorite = favorites.some((item) => item.path === note.path)
              return (
                <button
                  type="button"
                  aria-pressed={favorite}
                  onClick={() => void setFavorite(note.path, !favorite)}
                  title={favorite ? t('note.favoriteRemove') : t('note.favoriteAdd')}
                  aria-label={t('note.favorite')}
                  className={'shrink-0 rounded-full p-1.5 ' + (favorite ? 'bg-warn-500/10 text-warn-500' : 'text-mist-400 hover:bg-ink-850 hover:text-mist-100')}
                >
                  <Symbol name="star" className="h-4 w-4" />
                </button>
              )
            })()}
            <details ref={menu} className="relative shrink-0">
              <summary className="cursor-pointer list-none rounded-full p-1.5 text-mist-400 hover:bg-ink-850 hover:text-mist-100 [&::-webkit-details-marker]:hidden" aria-label={t('note.menu')} title={t('note.menu')}>
                <Symbol name="more" className="h-4 w-4" />
              </summary>
              <div className="absolute right-0 z-40 mt-1 w-60 rounded-xl border border-ink-700 bg-ink-900 p-1 shadow-xl" data-testid="note-menu">
                {menuItems.map((item, index) =>
                  item === 'separator' ? (
                    <div key={index} className="mx-2 my-1 h-px bg-ink-700" />
                  ) : (
                    <button
                      key={item.label}
                      type="button"
                      disabled={item.disabled}
                      onClick={(event) => {
                        ;(event.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open')
                        item.run()
                      }}
                      className={'flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm hover:bg-ink-850 disabled:opacity-40 ' + (item.danger ? 'text-bad-500' : 'text-mist-300')}
                    >
                      <Symbol name={item.symbol} className="h-4 w-4 shrink-0" />
                      <span className="flex-1">{item.label}</span>
                      {item.keys && <kbd className="font-mono text-[11px] text-mist-600">{item.keys}</kbd>}
                    </button>
                  ),
                )}
              </div>
            </details>
            <button
              type="button"
              onClick={togglePanel}
              aria-pressed={panelShown}
              aria-label={t('panel.toggle')}
              title={t('panel.toggleKeys')}
              className={'shrink-0 rounded-full p-1.5 ' + (panelShown ? 'bg-accent-500/10 text-accent-300' : 'text-mist-400 hover:bg-ink-850 hover:text-mist-100')}
            >
              <Symbol name="panel" className="h-4 w-4" />
            </button>
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
              {changed.author ? t('news.bannerBy', { name: nameOf(changed.author), when: formatDate(changed.changed_at) }) : t('news.bannerOutside', { when: formatDate(changed.changed_at) })}
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
          {lockedBy && <Banner tone="warn" symbol="lock">{note.lock?.own ? t('note.lockedOwnBanner') : t('note.lockedBanner', { name: lockedName })}</Banner>}
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
            <div ref={body} className={'mx-auto px-6 py-6 md:pl-16 ' + cssClasses.join(' ')} style={{ maxWidth: cssClasses.includes('wide') ? 'none' : 'calc(var(--nn-width) + 5.5rem)' }} data-testid="note-body">
              {/* The name of the file, large above the text as in Obsidian: a click (or F2) renames it. */}
              <div className="mb-1 -ml-1.5" data-testid="note-title">
                {renaming !== null ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault()
                      void rename(renaming)
                    }}
                  >
                    <input
                      autoFocus
                      aria-label={t('note.renameLabel')}
                      value={renaming}
                      onChange={(event) => setRenaming(event.target.value)}
                      onFocus={(event) => event.currentTarget.select()}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setRenaming(null)
                      }}
                      onBlur={() => renaming.trim() && renaming.trim() !== baseName(note.path) ? void rename(renaming) : setRenaming(null)}
                      className="w-full rounded-lg border border-accent-500 bg-ink-900 px-1.5 text-[1.9rem] leading-tight font-bold text-mist-100 outline-none"
                    />
                    <p className="mt-1 px-1.5 text-xs text-mist-500">{t('note.renameHint')}</p>
                  </form>
                ) : mayRename ? (
                  <button
                    type="button"
                    onClick={() => setRenaming(baseName(note.path))}
                    aria-label={t('note.renameTitle', { name: baseName(note.path) })}
                    title={t('note.renameTitle', { name: baseName(note.path) })}
                    className="w-full cursor-text rounded-lg border border-transparent px-1.5 text-left text-[1.9rem] leading-tight font-bold break-words text-mist-100 hover:bg-ink-850"
                  >
                    {baseName(note.path)}
                  </button>
                ) : (
                  <p className="px-1.5 text-[1.9rem] leading-tight font-bold break-words text-mist-100">{baseName(note.path)}</p>
                )}
              </div>
              <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-mist-500">
                {thisDay && (
                  <span className="flex items-center gap-1" data-testid="day-steps">
                    <button type="button" onClick={() => void stepDay(-1)} className="inline-flex items-center gap-0.5 rounded-full border border-ink-700 px-2 py-0.5 text-mist-300 hover:bg-ink-850">
                      <Symbol name="chevronLeft" className="h-3 w-3" /> {t('day.before')}
                    </button>
                    <button type="button" onClick={() => void stepDay(1)} className="inline-flex items-center gap-0.5 rounded-full border border-ink-700 px-2 py-0.5 text-mist-300 hover:bg-ink-850">
                      {t('day.after')} <Symbol name="chevronRight" className="h-3 w-3" />
                    </button>
                  </span>
                )}
                <span>{t('note.changed', { when: formatDate(savedAt ?? note.modified) })}</span>
                {/* While reading, tags in the front matter stand in the properties box below, not twice. */}
                {(editing || !/^tags\s*:/im.test(readingHead) ? note.tags : []).map((tag) => (
                  <Link key={tag} to={tagSearch(tag)} className="rounded-full bg-accent-500/10 px-2 py-0.5 text-accent-400 hover:bg-accent-500/20">#{tag}</Link>
                ))}
              </div>
              {!editing && readingHead && (
                // The properties while reading, as Obsidian shows them; open or shut the same for every note.
                <Suspense fallback={null}>
                  <Properties head={readingHead} readOnly onChange={() => undefined} remember="nexlore.readingProperties" />
                </Suspense>
              )}
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
                  onComment={(anchor) => {
                    setCommentDraft(anchor)
                    showPanel('comments')
                  }}
                  threads={threads}
                  onShowThread={(id) => {
                    setThreadFocus({ id, ask: Date.now() })
                    showPanel('comments')
                  }}
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
                  onKeyDown={(e) => {
                    const tag = (e.target as HTMLElement).closest<HTMLElement>('[data-tag]')
                    if (tag && e.key === 'Enter') navigate(tagSearch(tag.dataset.tag!))
                  }}
                  onClick={(e) => {
                    // A picture opens over the page, at its own size and to zoom into.
                    const image = (e.target as HTMLElement).closest('img')
                    if (image && article.current && !e.ctrlKey && !e.metaKey) {
                      e.preventDefault()
                      const { pictures, elements } = picturesIn(article.current)
                      const start = elements.indexOf(image as HTMLImageElement)
                      if (start >= 0) return setViewing({ pictures, start })
                    }
                    // A tag shows the notes with that tag, as a link does (it was a coloured word only, P4.7).
                    const tag = (e.target as HTMLElement).closest<HTMLElement>('[data-tag]')
                    if (tag) return void navigate(tagSearch(tag.dataset.tag!))
                    // A task's box, for who may write: ticked off as in the task list (it was locked, P5.2).
                    const box = (e.target as HTMLElement).closest<HTMLInputElement>('input[data-task]')
                    if (box && !box.disabled) return void tickInReading(box)
                    const target = (e.target as HTMLElement).closest('a[data-note]')
                    if (target) open(target.getAttribute('data-note')!, target.getAttribute('data-section') ?? '')
                    // A link to a note not written yet makes it, as in the editor (it did nothing here, P1.2).
                    const missing = (e.target as HTMLElement).closest('a[data-missing]')
                    if (missing) void openLink(missing.getAttribute('data-missing')!, e.ctrlKey || e.metaKey)
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
                <FoldLayer article={article} html={html} path={note.path} />
                <CommentLayer
                  article={article}
                  html={html}
                  threads={threads}
                  onAsk={(anchor) => {
                    setCommentDraft(anchor)
                    showPanel('comments')
                  }}
                  onFound={setCommentsFound}
                  onShowThread={(id) => {
                    setThreadFocus({ id, ask: Date.now() })
                    showPanel('comments')
                  }}
                />
                </>
              )}
            </div>
          </div>
          <WordCount body={body} content={editing ? '.ProseMirror' : 'article.nn-prose'} />
        </div>

        {panelShown && (
          <NotePanel
            parts={panelParts}
            tab={panelTab}
            onTab={(tab) => void setAppearance({ panel_tab: tab }).catch(() => {})}
            place={inline ? 'column' : phone ? 'bottom' : 'sheet'}
            onClose={closePanel}
          />
        )}
      </main>

      {merging && (
        <MergeDialog
          source={note.path}
          onClose={() => setMerging(false)}
          onDone={(target) => {
            setMerging(false)
            announceLeaving(note.path)
            void reload()
            navigate(noteUrl(target))
          }}
        />
      )}
      {viewing && (
        <ImageViewer pictures={viewing.pictures} start={viewing.start} archive={baseName(note.path).replace(/\.md$/i, '')} onClose={() => setViewing(null)} />
      )}
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
                        setInfo(taken.conflict ? (taken.reason === 'locked' ? t('proposals.takenLocked') : t('proposals.takenConflict')) : t('proposals.taken'))
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

function SaveBadge({ state, problem, onRetry }: { state: SaveState; problem: string | null; onRetry: () => void }) {
  const { t } = useTranslation()
  if (state === 'idle') return null
  const tone = state === 'failed' ? 'text-bad-500' : 'text-mist-500'
  // Why it failed, in words, and a way to try at once; the text stays in the editor meanwhile.
  const why = problem ? (problem === 'offline' ? t('note.save.offline') : problem === 'too_large' ? t('note.save.tooLarge') : errorText(problem)) : ''
  return (
    <span className={'flex items-center gap-2 text-xs ' + tone} role="status" title={why || t(`note.save.${state}`)}>
      {state !== 'failed' && <span aria-hidden="true" className="h-2 w-2 rounded-full bg-current sm:hidden" />}
      <span className={state === 'failed' ? '' : 'sr-only sm:not-sr-only'}>{t(`note.save.${state}`)}</span>
      {why && <span className="hidden max-w-72 truncate sm:inline">{why}</span>}
      {state === 'failed' && problem !== 'too_large' && (
        <button type="button" onClick={onRetry} className="rounded-md border border-bad-500/40 px-1.5 py-0.5 hover:bg-bad-500/10">
          {t('note.save.retry')}
        </button>
      )}
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
function Versions({ path, disabled, why, onRestored }: { path: string; disabled: boolean; why: string | null; onRestored: () => void }) {
  const { t } = useTranslation()
  const nameOf = usePeople()
  const [list, setList] = useState<VersionInfo[] | null>(null)
  const [shown, setShown] = useState<{ id: number; content: string } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setList(await vaultApi.versions(path))
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }, [path])
  // Read when the tab shows them, and again for another note.
  useEffect(() => {
    setList(null)
    setShown(null)
    void load()
  }, [load])

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
    <section data-testid="versions" aria-label={t('note.versions')}>
      {list === null ? (
        !problem && <p className="px-2 text-sm text-mist-600">{t('common.loading')}</p>
      ) : (
        <ul className="space-y-0.5">
          {list.map((version, index) => (
            <li key={version.id} className="rounded-lg px-2 py-1.5 text-sm hover:bg-ink-850">
              <div className="flex items-center gap-2">
                <span className="flex-1 text-mist-300">{formatDate(version.updated_at)}</span>
                <span className="text-[11px] text-mist-600">
                  {versionSource(version, t)}
                  {version.author ? ` · ${nameOf(version.author)}` : ''}
                </span>
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
                  <button type="button" disabled={disabled} title={disabled && why ? why : undefined} onClick={() => void restore(version.id)} className="text-accent-400 hover:text-accent-300 disabled:opacity-40">
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
      {disabled && why && list && list.length > 1 && <p className="mt-2 px-2 text-xs text-mist-500" data-testid="versions-why">{why}</p>}
      {problem && <p className="px-2 text-xs text-bad-500">{errorText(problem)}</p>}
    </section>
  )
}

function Section({ symbol, title, count, children }: { symbol: 'backlink' | 'link'; title: string; count: number | null; children: ReactNode }) {
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

/** The first place of `words` in a block, marked (only in the page: the note is not touched). */
function markIn(block: HTMLElement, words: string): void {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  const wanted = words.toLocaleLowerCase()
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? ''
    const at = text.toLocaleLowerCase().indexOf(wanted)
    if (at < 0) continue
    const range = document.createRange()
    range.setStart(node, at)
    range.setEnd(node, at + words.length)
    const mark = document.createElement('mark')
    mark.className = 'nn-hit'
    range.surroundContents(mark)
    return
  }
  block.classList.add('nn-hit-block')
}
