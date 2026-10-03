/**
 * A file edited the way nexlore edits: one person at a time, saved a moment after the last change, against the state
 * it was loaded as. Used by the canvas and by the note beside it.
 *
 * - The lock (`/api/locks`) is taken with the first change, renewed every 30 s and given back after a minute without
 *   one, and when the page goes. Somebody else holding it: the change is taken back and the file shown as theirs.
 * - A save 1.2 s after the last change; one that meets a file changed in between lands in a conflict copy (the
 *   server writes it) and the file is loaded again as it is.
 * - Every few seconds, while nothing waits to be saved, the state on disk is asked: a save from elsewhere (another
 *   tab, Obsidian) loads the file again; a lock somebody took shows.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, vaultApi, type Lock, type Saved } from '../api/client'

export type Loaded = { content: string; hash: string; lock: Lock | null; readonly: boolean; problem?: string | null }

export type FileBackend = {
  load: () => Promise<Loaded>
  state: () => Promise<{ hash: string; lock: Lock | null }>
  save: (content: string, baseHash: string, keepalive?: boolean) => Promise<Saved>
}

export const SAVE_AFTER_MS = 1200
export const LOCK_RENEW_MS = 30_000
export const LOCK_IDLE_MS = 60_000
export const POLL_MS = 5000

export type EditedFile = {
  status: 'loading' | 'ready' | 'failed'
  error: string | null
  /** The file as last loaded from the server; `version` counts each such load. */
  content: string
  version: number
  /** Shown only: the file cannot be kept (`problem`), the account may not write, or somebody else edits it. */
  readonly: boolean
  problem: string | null
  /** Who else is editing, as the server named them. */
  lockedBy: string | null
  /** Waiting to be saved, or being saved. */
  dirty: boolean
  /** The conflict copy the last save went into. */
  conflict: string | null
  /** A change to save; the first one takes the lock. */
  change: (content: string) => void
  /** Save what waits now (leaving, closing). */
  flush: () => Promise<void>
  /** Load the file again as it is on disk (after an old version came back). */
  reload: () => Promise<void>
  dismissConflict: () => void
}

export function useEditedFile(path: string, backend: FileBackend, canWrite: boolean): EditedFile {
  const [status, setStatus] = useState<EditedFile['status']>('loading')
  const [error, setError] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [version, setVersion] = useState(0)
  const [problem, setProblem] = useState<string | null>(null)
  const [lockedBy, setLockedBy] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)

  const hash = useRef('')
  const pending = useRef<string | null>(null)
  const holding = useRef(false)
  const saveTimer = useRef(0)
  const idleTimer = useRef(0)
  const renewTimer = useRef(0)
  const saving = useRef<Promise<void> | null>(null)
  const alive = useRef(true)
  const backendRef = useRef(backend)
  backendRef.current = backend

  const take = useCallback((loaded: Loaded) => {
    hash.current = loaded.hash
    setContent(loaded.content)
    setVersion((count) => count + 1)
    setProblem(loaded.readonly ? (loaded.problem ?? 'readonly') : null)
    setLockedBy(loaded.lock && !loaded.lock.mine ? loaded.lock.holder : null)
  }, [])

  const reload = useCallback(async () => {
    try {
      const loaded = await backendRef.current.load()
      if (alive.current) take(loaded)
    } catch (caught) {
      if (alive.current) setError(caught instanceof ApiError ? caught.code : 'internal_error')
    }
  }, [take])

  // Loading, and asking for the state on disk every few seconds.
  useEffect(() => {
    alive.current = true
    setStatus('loading')
    backendRef.current
      .load()
      .then((loaded) => {
        if (!alive.current) return
        take(loaded)
        setStatus('ready')
      })
      .catch((caught: unknown) => {
        if (!alive.current) return
        setError(caught instanceof ApiError ? caught.code : 'internal_error')
        setStatus('failed')
      })
    const poll = window.setInterval(() => {
      if (document.hidden || pending.current !== null || saving.current) return
      backendRef.current
        .state()
        .then((state) => {
          if (!alive.current || pending.current !== null || saving.current) return
          setLockedBy(state.lock && !state.lock.mine ? state.lock.holder : null)
          if (state.hash !== hash.current) void reload()
        })
        .catch(() => undefined)
    }, POLL_MS)
    return () => {
      alive.current = false
      window.clearInterval(poll)
    }
  }, [path, take, reload])

  const release = useCallback((keepalive = false) => {
    window.clearInterval(renewTimer.current)
    window.clearTimeout(idleTimer.current)
    if (!holding.current) return
    holding.current = false
    void vaultApi.unlock(path, keepalive).catch(() => undefined)
  }, [path])

  const save = useCallback(async (keepalive = false) => {
    window.clearTimeout(saveTimer.current)
    if (saving.current) await saving.current
    const text = pending.current
    if (text === null || !holding.current) return
    pending.current = null
    const run = (async () => {
      try {
        const result = await backendRef.current.save(text, hash.current, keepalive)
        hash.current = result.hash
        if (result.conflict) {
          if (alive.current) setConflict(result.conflict)
          await reload()
        }
      } catch (caught) {
        // Not saved: kept to try again with the next change (or the next leaving).
        if (pending.current === null) pending.current = text
        if (alive.current) setError(caught instanceof ApiError ? caught.code : 'internal_error')
      }
    })()
    saving.current = run
    await run
    saving.current = null
    if (alive.current && pending.current === null) setDirty(false)
  }, [reload])

  const lock = useCallback(async (): Promise<boolean> => {
    if (holding.current) return true
    try {
      await vaultApi.lock(path)
      holding.current = true
      window.clearInterval(renewTimer.current)
      renewTimer.current = window.setInterval(() => void vaultApi.lock(path).catch(() => undefined), LOCK_RENEW_MS)
      return true
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'locked') {
        setLockedBy(String(caught.values.holder ?? ''))
      } else setError(caught instanceof ApiError ? caught.code : 'internal_error')
      return false
    }
  }, [path])

  const change = useCallback(
    (next: string) => {
      if (!canWrite) return
      pending.current = next
      setDirty(true)
      setError(null)
      window.clearTimeout(idleTimer.current)
      idleTimer.current = window.setTimeout(() => {
        if (pending.current === null && !saving.current) release()
      }, LOCK_IDLE_MS)
      void lock().then((held) => {
        if (!held) {
          // Somebody else edits it: the change goes, the file as it is comes back.
          pending.current = null
          setDirty(false)
          void reload()
          return
        }
        window.clearTimeout(saveTimer.current)
        saveTimer.current = window.setTimeout(() => void save(), SAVE_AFTER_MS)
      })
    },
    [canWrite, lock, release, reload, save],
  )

  const flush = useCallback(() => save(), [save])

  // Leaving: what waits is saved (a closing tab may cut a long request; small ones go out with keepalive), the lock
  // given back.
  useEffect(() => {
    const leave = () => {
      if (pending.current !== null) void save(true)
      release(true)
    }
    window.addEventListener('pagehide', leave)
    window.addEventListener('beforeunload', leave)
    return () => {
      window.removeEventListener('pagehide', leave)
      window.removeEventListener('beforeunload', leave)
      void save().finally(() => release())
    }
  }, [save, release])

  return {
    status,
    error,
    content,
    version,
    readonly: !canWrite || problem !== null || lockedBy !== null,
    problem,
    lockedBy,
    dirty,
    conflict,
    change,
    flush,
    reload,
    dismissConflict: () => setConflict(null),
  }
}
