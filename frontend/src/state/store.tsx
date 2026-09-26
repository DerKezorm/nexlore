/**
 * What every page shares: the spaces, and every note with its links as one vault for the graph, the sidebar and the
 * quick switcher. Loaded from the server at the start and again after a change (`reload`).
 *
 * ⚠️ M1 loads the whole graph of every space. That is fine for a few thousand notes; M5 (WebGL graph) replaces it
 * with a graph that loads by region, and the sidebar then reads folders on demand (`/api/folder`).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { ApiError, vaultApi, type Space } from '../api/client'
import { computeLayout, type Layout } from '../graph/layout'
import { buildVault, vaultFromGraphs, type Vault } from '../lib/vault'

type Status = 'loading' | 'ready' | 'error'

type Store = {
  status: Status
  error: string | null
  spaces: Space[]
  vault: Vault
  /** Computed once per load, so the map does not rearrange itself while typing. */
  layout: Layout
  reload: () => Promise<void>
}

const StoreContext = createContext<Store | null>(null)
const EMPTY = buildVault([], [])

export function StoreProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [spaces, setSpaces] = useState<Space[]>([])
  const [vault, setVault] = useState<Vault>(EMPTY)
  const [layout, setLayout] = useState<Layout>(() => computeLayout(EMPTY))
  const loading = useRef<Promise<void> | null>(null)

  const reload = useCallback(() => {
    loading.current ??= (async () => {
      try {
        const list = await vaultApi.spaces()
        const graphs = await Promise.all(list.map((space) => vaultApi.graph(space.name)))
        const next = vaultFromGraphs(graphs)
        setSpaces(list)
        setVault(next)
        setLayout(computeLayout(next))
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

  const store = useMemo<Store>(() => ({ status, error, spaces, vault, layout, reload }), [status, error, spaces, vault, layout, reload])

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useStore(): Store {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore outside of StoreProvider')
  return store
}
