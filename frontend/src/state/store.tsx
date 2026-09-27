/**
 * What every page shares: the spaces the account may read. Loaded at the start and again after a change (`reload`);
 * `generation` counts the loads, so a page that shows notes (the sidebar, the graph) knows when to ask again.
 *
 * No note list and no graph live here: with 100,000 notes that would be megabytes per space. The sidebar reads folders
 * when they open (`/api/folder`), the quick switcher and the `[[` suggestions ask the server (`/api/notes/find`), and
 * the graph loads its circles and the part of the map it shows (`graph/`).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { ApiError, vaultApi, type Space } from '../api/client'

type Status = 'loading' | 'ready' | 'error'

type Store = {
  status: Status
  error: string | null
  spaces: Space[]
  /** Counts up with every load. */
  generation: number
  reload: () => Promise<void>
}

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

  const store = useMemo<Store>(() => ({ status, error, spaces, generation, reload }), [status, error, spaces, generation, reload])

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useStore(): Store {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore outside of StoreProvider')
  return store
}
