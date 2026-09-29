/**
 * "New since your last visit" in the browser: the notes others changed (`routers/news.py`), asked every minute, when
 * notes change and after a note was opened (it is seen then). One list for the sidebar's section and its dots.
 */
import { useSyncExternalStore } from 'react'
import { newsApi, type NewNote, type NewsMention } from '../api/client'

type State = { count: number; notes: NewNote[]; paths: Set<string>; mentions: NewsMention[] }

let state: State = { count: 0, notes: [], paths: new Set(), mentions: [] }
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
      (found) =>
        publish({ count: found.count, notes: found.notes, paths: new Set(found.notes.map((note) => note.path)), mentions: found.mentions ?? [] }),
      () => undefined,
    )
    .finally(() => {
      asking = null
    })
  return asking
}

/** A note was opened: it is seen, out of the list at once. */
export function seenNote(path: string): void {
  const mentions = state.mentions.filter((mention) => mention.path !== path)
  if (!state.paths.has(path) && mentions.length === state.mentions.length) return
  const notes = state.notes.filter((note) => note.path !== path)
  const count = state.paths.has(path) ? Math.max(0, state.count - 1) : state.count
  publish({ count, notes, paths: new Set(notes.map((note) => note.path)), mentions })
}

export async function seenAll(): Promise<void> {
  publish({ count: 0, notes: [], paths: new Set(), mentions: [] })
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
