/**
 * Display names (block X1). Notes, versions, comments and locks keep the account name, the one people sign in with and
 * write after @; what is shown is the display name, looked up here. Names asked for in the same moment go out as one
 * request; an answer is kept for the page's life, the own name is set at once when it changes.
 */
import { useSyncExternalStore } from 'react'
import { api } from '../api/client'

const known = new Map<string, string | null>()
const waiting = new Set<string>()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | null = null
let version = 0

function changed(): void {
  version++
  for (const listener of listeners) listener()
}

async function ask(): Promise<void> {
  timer = null
  const names = [...waiting]
  waiting.clear()
  if (!names.length) return
  try {
    const found = await api<Record<string, string>>('/api/people', { query: { name: names } })
    for (const name of names) known.set(name, found[name] || null)
  } catch {
    // Asked again next time it is drawn.
    for (const name of names) known.delete(name)
  }
  changed()
}

function want(name: string): void {
  if (known.has(name) || waiting.has(name)) return
  waiting.add(name)
  timer ??= setTimeout(() => void ask(), 20)
}

/** What a name shows as now (the name itself until the display name is known, or when there is none). */
export function shownName(name: string): string {
  return known.get(name) || name
}

/** The own display name, or another account's that just changed: known without asking. */
export function rememberName(name: string, display: string): void {
  known.set(name, display || null)
  changed()
}

/** The display name of an account name, asked for once and drawn again when it comes. */
export function useShownName(name: string | null | undefined): string {
  return usePeople()(name)
}

/** For lists and texts with several names: a function from account name to what it shows, drawn again as they come. */
export function usePeople(): (name: string | null | undefined) => string {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => version,
  )
  return (name) => {
    if (!name) return ''
    want(name)
    return shownName(name)
  }
}
