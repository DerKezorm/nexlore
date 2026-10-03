/**
 * The page of a canvas (`.canvas` in the vault), loaded only when one is opened: the sidebar, the canvas, and a note
 * beside it when one is opened from a card. It holds the steps back and forth, saves through `useEditedFile` (one
 * person at a time, a conflict copy when the file changed in between) and loads again what changed elsewhere.
 */
import '@xyflow/react/dist/style.css'
import '@milkdown/crepe/theme/common/style.css'
import '../styles/editor.css'
import './canvas.css'

import { ReactFlowProvider } from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { ApiError, canvasApi, vaultApi } from '../api/client'
import { Sidebar } from '../components/Sidebar'
import { Symbol } from '../components/Symbol'
import { ownKey } from '../lib/accountStorage'
import { errorText } from '../lib/errors'
import { fileRoute } from '../lib/markdown'
import { LinkIndex } from '../lib/links'
import { folderOf, noteUrl } from '../lib/vault'
import { useStore } from '../state/store'
import { CanvasView, type Apply } from './CanvasView'
import { CardsContext, targetOf, type CanvasCards, type NoteCache, type Targets } from './context'
import { CanvasError, EMPTY_CANVAS, parseCanvas, serializeCanvas, updateNodes, type Canvas } from './model'
import { NotePanel } from './NotePanel'
import { useEditedFile, type FileBackend } from './useEditedFile'
import { CanvasVersions } from './Versions'

/** How many steps back are kept. */
const STEPS = 100
const SNAP_KEY = 'nexlore.canvas.snap'
const TOUCH_HINT_KEY = 'nexlore.canvas.touchHint'

type History = { past: Canvas[]; present: Canvas; future: Canvas[] }

function remembered(key: string, fallback: string): string {
  try {
    return localStorage.getItem(ownKey(key)) ?? fallback
  } catch {
    return fallback
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(ownKey(key), value)
  } catch {
    // Storage blocked: it holds for this visit only.
  }
}

function useTouch(): boolean {
  const query = '(pointer: coarse)'
  const [touch, setTouch] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const list = matchMedia(query)
    const changed = () => setTouch(list.matches)
    list.addEventListener('change', changed)
    return () => list.removeEventListener('change', changed)
  }, [])
  return touch
}

export default function CanvasPage({ path }: { path: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { spaces } = useStore()
  const space = path.split('/')[0]
  const role = spaces.find((item) => item.name === space)?.role
  const touch = useTouch()
  // Where the cards lead for whoever looks (the server knows the rights), and cards laid down from elsewhere since.
  const [targets, setTargets] = useState<Targets>({ cards: {}, locked: new Set() })
  const placed = useRef(new Map<string, string>())
  const backend = useMemo<FileBackend>(
    () => ({
      load: () =>
        canvasApi.read(path).then((data) => {
          setTargets({ cards: data.cards ?? {}, locked: new Set(data.locked ?? []) })
          return { content: data.content, hash: data.hash, lock: data.lock, readonly: data.readonly, problem: data.problem }
        }),
      state: () => canvasApi.state(path),
      save: (content, baseHash, keepalive) => canvasApi.save(path, content, baseHash, keepalive),
    }),
    [path],
  )
  const file = useEditedFile(path, backend, role === 'write' || role === 'manage')
  const [history, setHistory] = useState<History>({ past: [], present: EMPTY_CANVAS, future: [] })
  const [unreadable, setUnreadable] = useState(false)
  // The state before a live change began (a card on its way, a text being typed): one step back goes there.
  const liveBase = useRef<Canvas | null>(null)
  const present = useRef(history.present)
  present.current = history.present

  // Loaded (first, or again after a change elsewhere): the canvas as it is now; steps back would lead to another file.
  useEffect(() => {
    if (!file.version) return
    try {
      const loaded = parseCanvas(file.content)
      setHistory({ past: [], present: loaded, future: [] })
      setUnreadable(false)
    } catch (caught) {
      if (caught instanceof CanvasError) setUnreadable(true)
    }
    liveBase.current = null
  }, [file.version, file.content])

  const save = file.change
  const apply = useCallback<Apply>(
    (next, live = false) => {
      const before = present.current
      present.current = next
      if (live) {
        liveBase.current ??= before
        setHistory((now) => ({ ...now, present: next }))
      } else {
        const base = liveBase.current ?? before
        liveBase.current = null
        if (base !== next) setHistory((now) => ({ past: [...now.past, base].slice(-STEPS), present: next, future: [] }))
      }
      if (next !== before) save(serializeCanvas(next))
    },
    [save],
  )
  // Steps back and forth from the history as it is drawn; saved outside the state update (React may run that twice).
  const shown = useRef(history)
  shown.current = history
  const step = useCallback(
    (next: History) => {
      shown.current = next
      present.current = next.present
      liveBase.current = null
      setHistory(next)
      save(serializeCanvas(next.present))
    },
    [save],
  )
  const undo = useCallback(() => {
    const now = shown.current
    const back = now.past.at(-1)
    if (back) step({ past: now.past.slice(0, -1), present: back, future: [now.present, ...now.future] })
  }, [step])
  const redo = useCallback(() => {
    const now = shown.current
    const forth = now.future[0]
    if (forth) step({ past: [...now.past, now.present], present: forth, future: now.future.slice(1) })
  }, [step])

  const [snapping, setSnappingState] = useState(() => remembered(SNAP_KEY, '1') === '1')
  const setSnapping = (on: boolean) => {
    setSnappingState(on)
    remember(SNAP_KEY, on ? '1' : '0')
  }

  // Notes on cards: each loaded once, and again after it was saved beside the canvas.
  const [generation, setGeneration] = useState(0)
  const loaded = useRef(new Map<string, Promise<string | null>>())
  const notes = useMemo<NoteCache>(
    () => ({
      generation,
      get: (note) => {
        let found = loaded.current.get(note)
        if (!found) {
          found = vaultApi.note(note).then(
            (data) => data.content,
            (error: unknown) => {
              if (error instanceof ApiError && error.status === 404) return null
              loaded.current.delete(note)
              throw error
            },
          )
          loaded.current.set(note, found)
        }
        return found
      },
      forget: (note) => {
        loaded.current.delete(note)
        setGeneration((count) => count + 1)
      },
    }),
    [generation],
  )

  // Where the wiki links of text cards lead, asked from where the canvas lies; the cards draw again with the answers.
  const [answers, setAnswers] = useState(0)
  const links = useMemo(() => new LinkIndex(path, () => setAnswers((count) => count + 1)), [path])

  const [panel, setPanel] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [menus, setMenus] = useState<HTMLElement | null>(null)

  const cards = useMemo<CanvasCards>(
    () => ({
      path,
      space,
      readonly: file.readonly || unreadable,
      touch,
      editing,
      setEditing,
      setText: (id, text, live) => {
        const node = present.current.nodes.find((item) => item.id === id)
        if (node && node.text !== text) apply(updateNodes(present.current, { [id]: { text } }), live)
        else if (!live) apply(present.current)
      },
      // Beside the canvas, from another space too (the panel asks with the rights of whoever looks).
      openNote: (note) => setPanel(note),
      openFile: (target) => navigate(/\.md$/i.test(target) ? noteUrl(target) : fileRoute(target)),
      target: (written) => targetOf(space, targets, placed.current, written),
      remember: (written, where) => void placed.current.set(written, where),
      notes,
      links,
      menus,
    }),
    // `answers`: a new answer about a link draws the text cards again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path, space, file.readonly, unreadable, touch, editing, apply, notes, links, menus, answers, navigate, targets],
  )

  // A finger on a phone: once, what works there.
  const [touchHint, setTouchHint] = useState(() => touch && remembered(TOUCH_HINT_KEY, '') !== 'seen')
  useEffect(() => {
    if (!touchHint) return
    remember(TOUCH_HINT_KEY, 'seen')
    const timer = window.setTimeout(() => setTouchHint(false), 6000)
    return () => window.clearTimeout(timer)
  }, [touchHint])

  const name = (path.split('/').pop() ?? '').replace(/\.canvas$/i, '')
  const problem = file.problem && file.problem !== 'readonly' ? file.problem : unreadable ? 'bad_canvas' : null
  return (
    <>
      <Sidebar activeNote={path} onNote={(next) => navigate(noteUrl(next))} />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-ink-700 px-4 py-2">
          <Symbol name="canvas" className="h-4 w-4 shrink-0 text-accent-400" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{name}</h1>
            <p className="truncate font-mono text-[11px] text-mist-500">{folderOf(path)}</p>
          </div>
          <span className="shrink-0 text-xs text-mist-500" aria-live="polite">
            {file.status !== 'ready' ? '' : file.readonly ? t('canvas.readOnly') : file.dirty ? t('canvas.saving') : t('canvas.saved')}
          </span>
          {file.status === 'ready' && (
            <CanvasVersions path={path} disabled={file.readonly || unreadable} before={file.flush} onRestored={() => void file.reload()} />
          )}
        </header>
        {problem && (
          <p className="border-b border-warn-500/30 bg-warn-500/10 px-4 py-2 text-sm text-warn-500" role="status">
            {t(`canvas.problem.${problem}`, { defaultValue: t('canvas.problem.bad_canvas') })}
          </p>
        )}
        {file.conflict && (
          <p className="border-b border-warn-500/30 bg-warn-500/10 px-4 py-2 text-sm text-warn-500" role="status">
            {t('canvas.conflict')}{' '}
            <button type="button" className="underline" onClick={() => navigate(fileRoute(file.conflict!))}>
              {t('canvas.showCopy')}
            </button>{' '}
            <button type="button" className="underline" onClick={file.dismissConflict}>
              {t('common.close')}
            </button>
          </p>
        )}
        {file.error && file.status === 'ready' && (
          <p className="border-b border-bad-500/30 bg-bad-500/10 px-4 py-2 text-sm text-bad-500" role="alert">
            {errorText(file.error)}
          </p>
        )}
        <div className="relative flex min-h-0 flex-1">
          {file.status === 'failed' ? (
            <p className="m-auto text-sm text-bad-500" role="alert">
              {file.error === 'not_found' ? t('file.notFound') : errorText(file.error ?? 'internal_error')}
            </p>
          ) : file.status === 'loading' ? (
            <p className="m-auto text-sm text-mist-500">{t('common.loading')}</p>
          ) : (
            <CardsContext.Provider value={cards}>
              <ReactFlowProvider>
                <CanvasView
                  canvas={history.present}
                  apply={apply}
                  undo={undo}
                  redo={redo}
                  canUndo={history.past.length > 0}
                  canRedo={history.future.length > 0}
                  snapping={snapping}
                  setSnapping={setSnapping}
                />
              </ReactFlowProvider>
              {file.lockedBy && (
                <p className="pointer-events-none absolute bottom-5 left-1/2 z-10 -translate-x-1/2 rounded-xl border border-warn-500/40 bg-ink-900/95 px-4 py-2 text-sm text-warn-500 shadow-lg" role="status">
                  {t('canvas.locked', { name: file.lockedBy })}
                </p>
              )}
              {touchHint && (
                <p className="absolute right-3 bottom-24 left-3 z-10 rounded-xl border border-ink-600 bg-ink-850 px-4 py-2 text-sm text-mist-300 shadow-lg" role="status">
                  {t('canvas.touchHint')}
                </p>
              )}
            </CardsContext.Provider>
          )}
          {panel && <NotePanel key={panel} path={panel} onClose={() => setPanel(null)} onSaved={notes.forget} onOpenNote={setPanel} />}
        </div>
      </main>
      {createPortal(
        <div className="nl-canvas-menus nx-note-editor">
          <div className="milkdown" ref={setMenus} />
        </div>,
        document.body,
      )}
    </>
  )
}
