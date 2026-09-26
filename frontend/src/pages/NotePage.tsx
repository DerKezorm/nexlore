/**
 * One note: reading view or editor, with backlinks, links and versions on the right.
 *
 * Editing takes the note's lock first; somebody else holding it sees who, and reads. The lock is renewed every
 * 30 seconds while the editor is open and given back on leaving. Typing saves by itself after a pause, always against
 * the state the editor started from: when the file changed in between (Obsidian, another device), the server writes
 * the edit into a conflict copy instead of overwriting, and the page says so.
 *
 * M1 edits the Markdown text itself; the real editor (Milkdown, WYSIWYG) comes with M2.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { ApiError, vaultApi, type Links, type NoteData, type VersionInfo } from '../api/client'
import { NoteEditor } from '../components/NoteEditor'
import { Sidebar } from '../components/Sidebar'
import { Symbol } from '../components/Symbol'
import { errorText } from '../lib/errors'
import { formatDate, renderMarkdown } from '../lib/markdown'
import { ancestry, baseName, folderOf, noteUrl } from '../lib/vault'
import { useStore } from '../state/store'

const SAVE_PAUSE = 1200
const HEARTBEAT = 30_000

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'failed'

export function NotePage() {
  // Already decoded by the router; decoding again breaks names with a "%" in them.
  const path = useParams()['*'] ?? ''
  const [params, setParams] = useSearchParams()
  const { t } = useTranslation()
  const { vault, reload } = useStore()
  const navigate = useNavigate()

  const [note, setNote] = useState<NoteData | null>(null)
  const [links, setLinks] = useState<Links | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  // Editing belongs to one note: moving on to another ends it in the same render, so nothing of the old note's
  // editor (its text, its lock, its save) can ever run against the new path.
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const editing = editingPath === path
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [conflict, setConflict] = useState<string | null>(null)
  const [lockHolder, setLockHolder] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)

  // What the editor holds, what was last written, and the file state it was written against.
  const draft = useRef('')
  const saved = useRef('')
  const base = useRef('')
  const timer = useRef<number | null>(null)
  const current = useRef(path)
  current.current = path

  const open = useCallback((next: string) => navigate(noteUrl(next)), [navigate])

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

  const save = useCallback(async (): Promise<boolean> => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    const text = draft.current
    if (text === saved.current) {
      setSaveState((state) => (state === 'pending' ? 'saved' : state))
      return true
    }
    setSaveState('saving')
    try {
      const result = await vaultApi.save(path, text, base.current)
      if (result.conflict) {
        // The text is safe in the copy. Leaving the editor must not save it a second time against the old state.
        saved.current = text
        draft.current = text
        setConflict(result.conflict)
        setEditingPath(null)
        setSaveState('idle')
        await vaultApi.unlock(path).catch(() => undefined)
        await Promise.all([load(path), reload()])
        return false
      }
      saved.current = text
      base.current = result.hash
      setSaveState(draft.current === text ? 'saved' : 'pending')
      return true
    } catch (error) {
      setSaveState('failed')
      if (error instanceof ApiError && error.code === 'locked') {
        setLockHolder(String(error.values.holder ?? ''))
        setEditingPath(null)
      }
      return false
    }
  }, [path, load, reload])

  const startEditing = useCallback(async () => {
    if (!note || note.readonly) return
    try {
      await vaultApi.lock(path)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'locked') setLockHolder(String(error.values.holder ?? ''))
      else setProblem(error instanceof ApiError ? error.code : 'internal_error')
      return
    }
    draft.current = note.content
    saved.current = note.content
    base.current = note.hash
    setLockHolder(null)
    setConflict(null)
    setSaveState('idle')
    setEditingPath(path)
  }, [note, path])

  const stopEditing = useCallback(async () => {
    await save()
    setEditingPath(null)
    await vaultApi.unlock(path).catch(() => undefined)
    await Promise.all([load(path), reload()])
  }, [save, path, load, reload])

  // A different note: back to reading, fresh data.
  useEffect(() => {
    setEditingPath(null)
    setConflict(null)
    setLockHolder(null)
    setRenaming(null)
    setSaveState('idle')
    if (path) void load(path)
  }, [path, load])

  // Coming from "new note": straight into the editor.
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
    // would run out by itself after 90 seconds anyway).
    const flush = (unloading: boolean) => {
      const pending = draft.current !== saved.current
      const text = draft.current
      const sent = pending ? vaultApi.save(path, text, base.current, true).catch(() => undefined) : Promise.resolve()
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
  }, [editing, path])

  const onChange = (text: string) => {
    draft.current = text
    setSaveState('pending')
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void save(), SAVE_PAUSE)
  }

  const resolve = useMemo(() => {
    const map = new Map<string, string>()
    for (const link of links?.outgoing ?? []) if (link.path) map.set(link.target.toLowerCase(), link.path)
    return (target: string) => map.get(target.toLowerCase()) ?? null
  }, [links])
  const html = useMemo(() => (note ? renderMarkdown(note.content, resolve) : ''), [note, resolve])
  const titles = useMemo(() => [...vault.notes.values()].map((n) => n.title).sort((a, b) => a.localeCompare(b)), [vault])

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

  const remove = async () => {
    if (!note || !window.confirm(t('note.deleteConfirm', { title: note.title }))) return
    try {
      await vaultApi.remove(note.path)
      await reload()
      navigate('/')
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
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

  const chain = ancestry(vault, note.path)
  const foreignLock = note.lock && !note.lock.mine ? note.lock.holder : null
  const lockedBy = lockHolder ?? foreignLock

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
                disabled={!!lockedBy || note.readonly}
                title={lockedBy ? t('note.lockedTitle', { name: lockedBy }) : note.readonly ? t('note.readonlyTitle') : undefined}
                className={'inline-flex items-center gap-1.5 rounded-full px-3 py-1 disabled:cursor-not-allowed disabled:opacity-40 ' + (editing ? 'bg-accent-500 font-semibold text-on-accent' : 'text-mist-400 hover:text-mist-100')}
              >
                <Symbol name="pencil" className="h-3.5 w-3.5" /> {t('note.edit')}
              </button>
            </div>
            <Link to={`/?focus=${encodeURIComponent(note.path)}`} className="inline-flex items-center gap-1.5 rounded-full border border-ink-700 px-3 py-1 text-sm text-mist-300 hover:bg-ink-850">
              <Symbol name="graph" className="h-3.5 w-3.5" /> {t('note.inGraph')}
            </Link>
            {!editing && (
              <>
                <button type="button" onClick={() => setRenaming(baseName(note.path))} className="rounded-full border border-ink-700 px-3 py-1 text-sm text-mist-300 hover:bg-ink-850">
                  {t('note.rename')}
                </button>
                <button type="button" onClick={() => void remove()} disabled={!!lockedBy} className="rounded-full border border-ink-700 px-3 py-1 text-sm text-bad-500 hover:bg-ink-850 disabled:opacity-40">
                  {t('note.delete')}
                </button>
              </>
            )}
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
          {lockedBy && (
            <Banner tone="warn" symbol="lock">{t('note.lockedBanner', { name: lockedBy })}</Banner>
          )}
          {conflict && (
            <Banner tone="warn" symbol="alert">
              {t('note.conflict')}{' '}
              <button type="button" onClick={() => open(conflict)} className="font-semibold underline">{baseName(conflict)}</button>
            </Banner>
          )}
          {note.readonly && <Banner tone="warn" symbol="alert">{t('note.readonlyBanner')}</Banner>}
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
                <NoteEditor key={note.path} value={draft.current} titles={titles} onChange={onChange} />
              ) : (
                <article
                  className="nn-prose"
                  onClick={(e) => {
                    const target = (e.target as HTMLElement).closest('a[data-note]')
                    if (target) open(target.getAttribute('data-note')!)
                  }}
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              )}
            </div>
          </div>
        </div>

        {/* Right column */}
        <aside className="nn-scroll hidden w-72 shrink-0 overflow-y-auto border-l border-ink-700/80 px-4 py-4 xl:block">
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
                <button key={index} type="button" onClick={() => open(item.path!)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm text-mist-300 hover:bg-ink-850">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: vault.home.get(item.path)?.color ?? 'var(--color-mist-600)' }} />
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
          <Versions path={note.path} disabled={editing || !!lockedBy} onRestored={() => void Promise.all([load(note.path), reload()])} />
        </aside>
      </main>
    </>
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

function Banner({ tone, symbol, children }: { tone: 'warn' | 'bad'; symbol: 'lock' | 'alert'; children: ReactNode }) {
  const colors = tone === 'warn' ? 'border-warn-500/30 bg-warn-500/10 text-warn-500' : 'border-bad-500/30 bg-bad-500/10 text-bad-500'
  return (
    <div className={'mx-6 mt-4 flex items-center gap-3 rounded-xl border px-4 py-2.5 text-sm ' + colors} role="alert">
      <Symbol name={symbol} />
      <span className="flex-1">{children}</span>
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
