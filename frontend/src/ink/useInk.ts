/**
 * A drawing as it is edited: loaded from `/api/ink`, saved a moment after the last change (one person at a time,
 * against the state it was loaded as, a conflict copy when it changed in between: `canvas/useEditedFile.ts`), with
 * its steps back and forth and the strokes chosen with the lasso.
 *
 * What goes back is what came, with the strokes, the paper and the view of now: the recognised text (`text`,
 * `words`) and every field this version does not know stay as they were.
 *
 * The tools (pen, colour, size) are one set for the whole tab: a pen chosen in one drawing is the pen in the next.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { inkApi } from '../api/client'
import { useEditedFile, type EditedFile, type FileBackend } from '../canvas/useEditedFile'
import { composeInk, readInk, type Ink, type InkBackground, type InkStroke, type InkView } from '../lib/ink'
import { useStore } from '../state/store'
import { NO_HISTORY, START_TOOLS, recorded, stepBack, stepForth, type History, type Snapshot, type Tools } from './logic'

export type InkController = Pick<EditedFile, 'status' | 'error' | 'problem' | 'readonly' | 'lockedBy' | 'dirty' | 'conflict' | 'dismissConflict' | 'flush' | 'reload'> & {
  path: string
  /** The drawing as last loaded (null until then, and for an SVG that is no drawing). */
  loaded: Ink | null
  /** The path `loaded` came from (null: the empty one of a drawing not made yet). */
  source: string | null
  strokes: InkStroke[]
  bg: InkBackground
  /** The view kept in the file (D9), as last saved. */
  view: InkView | undefined
  /** A finished change: a step back, and saved after a moment. */
  commit: (strokes: InkStroke[], bg?: InkBackground) => void
  canUndo: boolean
  canRedo: boolean
  undo: () => void
  redo: () => void
  /** The strokes chosen with the lasso, by their place in `strokes`. */
  selection: number[]
  select: (picked: number[]) => void
  /** The view to keep with the drawing (a block's "Done"); saved when it differs from the one kept. */
  keepView: (view: InkView) => void
  /** Space held: dragging moves the picture instead of drawing. */
  space: { current: boolean }
}

/** A drawing that is not made yet (a canvas before its first stroke): empty, never asked for, never saved. */
const NOT_YET: FileBackend = {
  load: () => Promise.resolve({ content: JSON.stringify({ v: 1, bg: 'none', strokes: [] }), hash: '', lock: null, readonly: false, problem: null }),
  state: () => Promise.resolve({ hash: '', lock: null }),
  save: () => Promise.reject(new Error('no drawing yet')),
}

/**
 * The drawing at `path`. `null` (`inSpace` names the space it will lie in): none yet, an empty one to show; whoever holds
 * it makes the file before the first change is committed (`canvas/useCanvasInk.ts`).
 */
export function useInk(path: string | null, inSpace?: string): InkController {
  const { spaces } = useStore()
  const role = spaces.find((item) => item.name === (path ?? inSpace ?? '').split('/')[0])?.role
  const backend = useMemo<FileBackend>(
    () => path === null ? NOT_YET : ({
      load: () =>
        inkApi.read(path).then((data) => ({
          content: data.ink ? JSON.stringify(data.ink) : '',
          hash: data.hash,
          lock: data.lock,
          readonly: data.readonly || !data.ink,
          problem: data.problem ?? (data.ink ? null : 'not_ink'),
        })),
      state: () => inkApi.state(path),
      save: (content, baseHash, keepalive) => inkApi.save(path, JSON.parse(content) as Record<string, unknown>, baseHash, keepalive, content.length),
    }),
    [path],
  )
  const file = useEditedFile(path ?? '', backend, role === 'write' || role === 'manage')

  const [loaded, setLoaded] = useState<Ink | null>(null)
  const [source, setSource] = useState<string | null>(null)
  const [present, setPresent] = useState<Snapshot>({ strokes: [], bg: 'none' })
  const [view, setView] = useState<InkView | undefined>(undefined)
  const [history, setHistory] = useState<History>(NO_HISTORY)
  const [selection, setSelection] = useState<number[]>([])
  const space = useRef(false)

  // Loaded (first, or again after a change elsewhere or a conflict): the drawing as it is now; steps back would lead
  // to another file.
  useEffect(() => {
    if (!file.version) return
    setSource(path)
    if (!file.content) {
      setLoaded(null)
      return
    }
    let raw: unknown
    try {
      raw = JSON.parse(file.content)
    } catch {
      raw = null
    }
    const ink = readInk(raw)
    setLoaded(ink)
    setPresent({ strokes: ink.strokes, bg: ink.bg })
    setView(ink.view)
    setHistory(NO_HISTORY)
    setSelection([])
    // A new load is what counts, not a new path before it (`source` tells the two apart).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.version, file.content])

  // What is drawn now and what saving needs, read when a change comes (several may come before the page draws again).
  const now = useRef({ loaded, present, view, history })
  now.current = { loaded, present, view, history }

  const { change } = file
  const write = useCallback(
    (snapshot: Snapshot, keptView: InkView | undefined) => {
      const base = now.current.loaded
      if (!base) return
      change(JSON.stringify(composeInk(base, snapshot.strokes, snapshot.bg, keptView ?? null)))
    },
    [change],
  )

  const commit = useCallback(
    (strokes: InkStroke[], bg?: InkBackground) => {
      const before = now.current.present
      const next = { strokes, bg: bg ?? before.bg }
      if (next.strokes === before.strokes && next.bg === before.bg) return
      const history = recorded(now.current.history, before)
      now.current = { ...now.current, present: next, history }
      setPresent(next)
      setHistory(history)
      write(next, now.current.view)
    },
    [write],
  )

  const step = useCallback(
    (moved: { history: History; present: Snapshot } | null) => {
      if (!moved) return
      now.current = { ...now.current, ...moved }
      setPresent(moved.present)
      setHistory(moved.history)
      setSelection([])
      write(moved.present, now.current.view)
    },
    [write],
  )
  const undo = useCallback(() => step(stepBack(now.current.history, now.current.present)), [step])
  const redo = useCallback(() => step(stepForth(now.current.history, now.current.present)), [step])

  const keepView = useCallback(
    (next: InkView) => {
      now.current = { ...now.current, view: next }
      setView(next)
      write(now.current.present, next)
    },
    [write],
  )

  return {
    path: path ?? '',
    status: file.status,
    error: file.error,
    problem: file.problem,
    readonly: file.readonly || !loaded,
    lockedBy: file.lockedBy,
    dirty: file.dirty,
    conflict: file.conflict,
    dismissConflict: file.dismissConflict,
    flush: file.flush,
    reload: file.reload,
    loaded,
    source,
    strokes: present.strokes,
    bg: present.bg,
    view,
    commit,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    undo,
    redo,
    selection,
    select: setSelection,
    keepView,
    space,
  }
}

// --- The tools, one set for the tab ------------------------------------------------------------------------------------

let tools: Tools = START_TOOLS
const listeners = new Set<() => void>()

export function setTools(next: Tools): void {
  tools = next
  for (const listener of listeners) listener()
}

export function useTools(): [Tools, (next: Tools) => void] {
  const shown = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    () => tools,
  )
  return [shown, setTools]
}
