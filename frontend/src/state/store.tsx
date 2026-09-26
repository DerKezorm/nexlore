/**
 * Mockup state: the notes live in memory and are lost on reload. Later this is the server, with the Markdown files
 * on disk as the truth.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

import { computeLayout, type Layout } from '../graph/layout'
import { buildVault, type Vault } from '../lib/vault'
import { NOTES, type Note } from '../mock/notes'

type Store = {
  vault: Vault
  /** Computed once from the start state, so the map does not rearrange itself while typing. */
  layout: Layout
  updateBody: (id: string, body: string) => void
  acceptDraft: (id: string) => void
}

const StoreContext = createContext<Store | null>(null)

const initialLayout = computeLayout(buildVault(NOTES))

export function StoreProvider({ children }: { children: ReactNode }) {
  const [notes, setNotes] = useState<Note[]>(NOTES)
  const vault = useMemo(() => buildVault(notes), [notes])

  const store = useMemo<Store>(
    () => ({
      vault,
      layout: initialLayout,
      updateBody: (id, body) =>
        setNotes((list) => list.map((n) => (n.id === id ? { ...n, body, updated: new Date().toISOString() } : n))),
      acceptDraft: (id) => setNotes((list) => list.map((n) => (n.id === id ? { ...n, aiDraft: false, author: 'Alex' } : n))),
    }),
    [vault],
  )

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useStore(): Store {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore outside of StoreProvider')
  return store
}
