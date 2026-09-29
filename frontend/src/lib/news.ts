/**
 * "New since your last visit" in the browser: the notes others changed (`routers/news.py`), asked every minute, when
 * notes change and after a note was opened (it is seen then). One list for the sidebar's section and its dots.
 */
import { useSyncExternalStore } from 'react'
import { newsApi, type NewNote } from '../api/client'

type State = { count: number; notes: NewNote[]; paths: Set<string> }

let state: State = { count: 0, notes: [], paths: new Set() }
const listeners = new Set<() => void>()
let asking: Promise<void> | null = null

function publish(next: State): void {
  state = next
  for (const listener of listeners) listener()
}

export function refreshNews(): Promise<void> {
  asking ??= newsApi
    .list()
    .then(
      (found) => publish({ count: found.count, notes: found.notes, paths: new Set(found.notes.map((note) => note.path)) }),
      () => undefined,
    )
    .finally(() => {
      asking = null
    })
  return asking
}

/** A note was opened: it is seen, out of the list at once. */
export function seenNote(path: string): void {
  if (!state.paths.has(path)) return
  const notes = state.notes.filter((note) => note.path !== path)
  publish({ count: Math.max(0, state.count - 1), notes, paths: new Set(notes.map((note) => note.path)) })
}

export async function seenAll(): Promise<void> {
  publish({ count: 0, notes: [], paths: new Set() })
  await newsApi.seenAll()
  await refreshNews()
}

export function useNews(): State {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
  )
}
