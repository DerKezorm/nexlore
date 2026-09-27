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
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { ApiError, vaultApi, type Links, type NoteData, type Uploaded, type VersionInfo } from '../api/client'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { ConflictCompare } from '../components/ConflictCompare'
import type { EditorHandle, EditorMode } from '../components/NoteEditor'
import { Sidebar } from '../components/Sidebar'
import { Symbol } from '../components/Symbol'
import { copiesOf, originalOf } from '../lib/compare'
import { errorText } from '../lib/errors'
import { isFileTarget, isNotePath } from '../lib/files'
import { LinkIndex } from '../lib/links'
import { fileRoute, formatDate, renderMarkdown } from '../lib/markdown'
import { baseName, folderOf, noteUrl } from '../lib/vault'
import { useAuth } from '../state/auth'
import { useStore } from '../state/store'
import { LocalGraph } from '../components/LocalGraph'
import { ShareDialog } from '../components/ShareDialog'
import { folderColor } from '../graph/palette'

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

export function NotePage() {
  // Already decoded by the router; decoding again breaks names with a "%" in them.
  const path = useParams()['*'] ?? ''
  const [params, setParams] = useSearchParams()
  const { t } = useTranslation()
  const { reload, spaces, generation } = useStore()
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
  useEffect(() => {
    let live = true
    vaultApi.copies(path).then(
      (found) => live && setSiblings(found.paths),
      () => live && setSiblings([]),
    )
    return () => {
      live = false
    }
  }, [path, generation])
  const [problem, setProblem] = useState<string | null>(null)
  // Editing belongs to one note: moving on to another ends it in the same render, so nothing of the old note's
  // editor (its text, its lock, its save) can ever run against the new path.
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const editing = editingPath === path
  const [mode, setMode] = useState<EditorMode>('visual')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [conflict, setConflict] = useState<string | null>(null)
  const [comparing, setComparing] = useState<{ note: string; copy: string } | null>(null)
  const [lockHolder, setLockHolder] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  // Files only this note uses, offered to go into the trash with it; and whether they do.
  const [own, setOwn] = useState<string[]>([])
  const [withOwn, setWithOwn] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
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

  const open = useCallback((next: string) => navigate(noteUrl(next)), [navigate])

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

  const load = useCallback(async (target: string) => {
    try {
      const [data, found] = await Promise.all([vaultApi.note(target), vaultApi.links(target)])
      if (current.current !== target) return
      setNote(data)
      setLinks(found)
      setProblem(null)
    } catch (error) {
      if (current.current !== target) return
      setNote(null)
      setLinks(null)
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }, [])

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

  // A different note: back to reading, fresh data.
  useEffect(() => {
    setEditingPath(null)
    setConflict(null)
    setComparing(null)
    setLockHolder(null)
    setRenaming(null)
    setNotice(null)
    setInfo(null)
    setSaveState('idle')
    if (path) void load(path)
  }, [path, load])

  // Coming from "new note" (or a click on a link to a note not yet written): straight into the editor.
  useEffect(() => {
    if (note && params.get('edit') === '1' && !editing) {
      setParams({}, { replace: true })
      void startEditing()
    }
  }, [note, params, editing, setParams, startEditing])

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
    if (!note) return
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
  }, [path, note, load])

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
  const copies = useMemo(() => copiesOf(path, siblings), [path, siblings])
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
      if (newTab) window.open(noteUrl(found), '_blank', 'noopener')
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
    const title = target.split('#')[0].split('/').pop()?.trim()
    if (!title) return
    try {
      const made = await vaultApi.create(folderOf(path), title)
      await reload()
      navigate(`${noteUrl(made.path)}?edit=1`)
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
    try {
      await vaultApi.remove(note.path, withOwn ? own : [])
      await reload()
      navigate('/')
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }

  // Comparing while editing would let two saves race (the editor's and the comparison's): editing ends first.
  const compare = async (notePath: string, copyPath: string) => {
    if (editing && !(await stopEditing())) return
    setComparing({ note: notePath, copy: copyPath })
  }

  const uploaded = (done: Uploaded[]) => {
    const removed = new Set(done.flatMap((item) => item.removed))
    const parts = [t('note.uploaded', { count: done.length })]
    if (removed.has('location') || removed.has('device') || removed.has('metadata')) parts.push(t('note.uploadedCleaned'))
    if (removed.has('unchecked')) parts.push(t('note.uploadedUnchecked'))
    if (done.some((item) => item.duplicate)) parts.push(t('note.uploadedDuplicate'))
    setInfo(parts.join(' '))
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

  if (!path) {
    return (
      <>
        <Sidebar activeNote={null} onNote={open} />
        <main className="flex flex-1 items-center justify-center px-6 text-center text-mist-500">{t('note.pick')}</main>
      </>
    )
  }

  if (!note) {
    return (
      <>
        <Sidebar activeNote={path} onNote={open} />
        <main className="flex flex-1 items-center justify-center px-6 text-center text-mist-500">
          {problem ? (problem === 'not_found' ? t('note.notFound') : errorText(problem)) : t('common.loading')}
        </main>
      </>
    )
  }

  const showInGraph = () => navigate(`/?focus=${encodeURIComponent(note.path)}`)
  const chain = note.path.split('/').slice(0, -1).map((name, index, all) => ({ id: all.slice(0, index + 1).join('/'), name }))
  const foreignLock = note.lock && !note.lock.mine ? note.lock.holder : null
  const lockedBy = lockHolder ?? foreignLock
  // The own right in the note's space: reading only hides every change; managing may share.
  const role = spaces.find((space) => space.name === note.path.split('/')[0])?.role ?? 'read'
  const mayWrite = role !== 'read'

  return (
    <>
      <Sidebar key={'tree-' + note.path} activeNote={note.path} onNote={open} />
      <main className="flex min-w-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Toolbar */}
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-ink-700/80 px-6 py-2.5">
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
                disabled={!!lockedBy || note.readonly || !mayWrite}
                title={
                  !mayWrite
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
            <Link to={`/?focus=${encodeURIComponent(note.path)}`} className="inline-flex items-center gap-1.5 rounded-full border border-ink-700 px-3 py-1 text-sm text-mist-300 hover:bg-ink-850">
              <Symbol name="graph" className="h-3.5 w-3.5" /> {t('note.inGraph')}
            </Link>
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
          {renaming !== null && (
            <form
              className="mx-6 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-ink-700 bg-ink-850 px-4 py-2.5 text-sm"
              onSubmit={(event) => {
                event.preventDefault()
                void rename(renaming)
              }}
            >
              <label htmlFor="rename" className="text-mist-400">{t('note.renameLabel')}</label>
              <input id="rename" autoFocus value={renaming} onChange={(event) => setRenaming(event.target.value)} className="h-8 min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-2 outline-none focus:border-accent-500" />
              <button type="submit" className="rounded-full bg-accent-500 px-3 py-1 font-semibold text-on-accent">{t('note.renameDo')}</button>
              <button type="button" onClick={() => setRenaming(null)} className="rounded-full px-3 py-1 text-mist-400 hover:text-mist-100">{t('common.cancel')}</button>
              <p className="w-full text-xs text-mist-500">{t('note.renameHint')}</p>
            </form>
          )}
          {lockedBy && <Banner tone="warn" symbol="lock">{t('note.lockedBanner', { name: lockedBy })}</Banner>}
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
          <div className="nn-scroll min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl px-6 py-6">
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
                  onFileRefused={() => setNotice(t('note.fileRefused'))}
                  onUploaded={uploaded}
                  onUploadFailed={(code) => setNotice(errorText(code))}
                />
                </Suspense>
              ) : (
                <article
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
              )}
              {!wide && (
                <div className="mt-10">
                  <LocalGraph path={note.path} generation={generation} onOpen={open} onShowInGraph={showInGraph} />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right column */}
        <aside className="nn-scroll hidden w-80 shrink-0 overflow-y-auto border-l border-ink-700/80 px-4 py-4 xl:block">
          {wide && (
            <div className="mb-5">
              <LocalGraph path={note.path} generation={generation} onOpen={open} onShowInGraph={showInGraph} />
            </div>
          )}
          <Section symbol="backlink" title={t('note.backlinks')} count={links?.backlinks.length ?? 0}>
            {links?.backlinks.length === 0 && <p className="px-2 text-sm text-mist-600">{t('note.noBacklinks')}</p>}
            {links?.backlinks.map((item) => (
              <button key={item.path + item.line} type="button" onClick={() => open(item.path)} className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-ink-850">
                <span className="block text-sm font-medium text-mist-200">{item.title}</span>
                <span className="block truncate text-xs text-mist-500">{folderOf(item.path)}</span>
              </button>
            ))}
          </Section>
          <Section symbol="link" title={t('note.outgoing')} count={links?.outgoing.length ?? 0}>
            {links?.outgoing.map((item, index) =>
              item.path ? (
                <button key={index} type="button" onClick={() => (isNotePath(item.path!) ? open(item.path!) : openFile(item.path!))} className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm text-mist-300 hover:bg-ink-850">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: folderColor(item.path) }} />
                  <span className="truncate">{item.title}</span>
                </button>
              ) : (
                <div key={index} className="flex items-center gap-2 px-2 py-1 text-sm text-mist-600" title={t('note.missingLink')}>
                  <span className="h-2 w-2 shrink-0 rounded-full border border-dashed border-mist-600" />
                  <span className="truncate">{item.target}</span>
                </div>
              ),
            )}
          </Section>
          <Versions path={note.path} disabled={editing || !!lockedBy || !mayWrite} onRestored={() => void Promise.all([load(note.path), reload()])} />
        </aside>
      </main>

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
                <span className="text-[11px] text-mist-600">{t(`note.source.${version.source}`, { defaultValue: version.source })}</span>
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
