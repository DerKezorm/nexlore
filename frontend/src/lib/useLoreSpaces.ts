/**
 * The spaces Lore looks in, kept with the account (`appearance.lore_hidden`, design answer 05.10.2026): every readable
 * one, less those left out. All left out (chosen elsewhere, or the last one shown is gone): Lore looks in all of them
 * rather than in none. The last one shown cannot be left out.
 */
import { useMemo } from 'react'

import { useAuth } from '../state/auth'
import { useStore } from '../state/store'

export function useLoreSpaces() {
  const { me, setAppearance } = useAuth()
  const { spaces } = useStore()
  const hiddenIds = me?.appearance?.lore_hidden
  const hidden = useMemo(() => {
    const ids = new Set(hiddenIds ?? [])
    return spaces.some((space) => !ids.has(space.id)) ? ids : new Set<number>()
  }, [hiddenIds, spaces])
  /** What goes to the server: undefined for every readable space. */
  const chosen = hidden.size ? spaces.filter((space) => !hidden.has(space.id)).map((space) => space.id) : undefined
  const toggle = (id: number) => {
    const next = new Set(hidden)
    if (next.has(id)) next.delete(id)
    else if (spaces.filter((space) => !next.has(space.id)).length > 1) next.add(id)
    void setAppearance({ lore_hidden: spaces.filter((space) => next.has(space.id)).map((space) => space.id) }).catch(() => undefined)
  }
  return { spaces, hidden, chosen, toggle }
}
