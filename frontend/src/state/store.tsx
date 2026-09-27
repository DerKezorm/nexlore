/**
 * What every page shares: the spaces the account may read. Loaded at the start and again after a change (`reload`);
 * `generation` counts the loads, so a page that shows notes (the sidebar, the graph) knows when to ask again.
 *
 * And whether the vault is being read (`scan`): asked every 30 s, every 2 s while a pass runs. Meanwhile the spaces are
 * loaded again every 10 s, so notes appear as they are read, and once more when the pass is over.
 *
 * No note list and no graph live here: with 100,000 notes that would be megabytes per space. The sidebar reads folders
 * when they open (`/api/folder`), the quick switcher and the `[[` suggestions ask the server (`/api/notes/find`), and
 * the graph loads its circles and the part of the map it shows (`graph/`).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { ApiError, type IndexProgress, vaultApi, type Space } from '../api/client'

type Status = 'loading' | 'ready' | 'error'

type Store = {
  status: Status
  error: string | null
  spaces: Space[]
  /** Counts up with every load. */
  generation: number
  reload: () => Promise<void>
  scan: IndexProgress
}

export const SCAN_IDLE_MS = 30_000
export const SCAN_RUNNING_MS = 2_000
export const SCAN_RELOAD_MS = 10_000

const StoreContext = createContext<Store | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [spaces, setSpaces] = useState<Space[]>([])
  const [generation, setGeneration] = useState(0)
  const loading = useRef<Promise<void> | null>(null)

  const reload = useCallback(() => {
    loading.current ??= (async () => {
      try {
        setSpaces(await vaultApi.spaces())
        setGeneration((value) => value + 1)
        setError(null)
        setStatus('ready')
      } catch (problem) {
        setError(problem instanceof ApiError ? problem.code : 'internal_error')
        setStatus('error')
      } finally {
        loading.current = null
      }
    })()
    return loading.current
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const [scan, setScan] = useState<IndexProgress>({ running: false })
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let alive = true
    let wasRunning = false
    let lastReload = Date.now()
    const ask = async () => {
      let running = wasRunning
      try {
        const answer = await vaultApi.progress()
        if (!alive) return
        running = answer.running
        setScan(answer)
        const now = Date.now()
        if ((wasRunning && !running) || (running && now - lastReload >= SCAN_RELOAD_MS)) {
          lastReload = now
          void reload()
        }
        wasRunning = running
      } catch {
        // Not reachable or signed out: nothing to tell, the pages say what they need.
      }
      if (alive) timer = setTimeout(() => void ask(), running ? SCAN_RUNNING_MS : SCAN_IDLE_MS)
    }
    void ask()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [reload])

  const store = useMemo<Store>(
    () => ({ status, error, spaces, generation, reload, scan }),
    [status, error, spaces, generation, reload, scan],
  )

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useStore(): Store {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore outside of StoreProvider')
  return store
}
