/**
 * "New since your last visit" in the browser: the notes others changed (`routers/news.py`), asked every minute, when
 * notes change and after a note was opened (it is seen then). One list for the sidebar's section and its dots.
 */
import { useSyncExternalStore } from 'react'
import { mcpApi, newsApi, noticesApi, type McpRequest, type NewNote, type NewsMention, type SpaceNotice } from '../api/client'
import { REQUESTS_EVENT } from './mcpRequests'

/** ``requests``: what AI programs wait to have approved (block Y); they stay until decided in nexlore. */
type State = { count: number; notes: NewNote[]; paths: Set<string>; mentions: NewsMention[]; notices: SpaceNotice[]; requests: McpRequest[] }

let state: State = { count: 0, notes: [], paths: new Set(), mentions: [], notices: [], requests: [] }
const listeners = new Set<() => void>()
let asking: Promise<void> | null = null

function publish(next: State): void {
  state = next
  for (const listener of listeners) listener()
}

export function refreshNews(): Promise<void> {
  asking ??= Promise.all([newsApi.list(), noticesApi.list().catch(() => []), mcpApi.requests().catch(() => [])])
    .then(
      ([found, notices, requests]) =>
        publish({
          count: found.count,
          notes: found.notes,
          paths: new Set(found.notes.map((note) => note.path)),
          mentions: found.mentions ?? [],
          notices,
          requests: requests.filter((request) => request.status === 'waiting'),
        }),
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
  publish({ ...state, count, notes, paths: new Set(notes.map((note) => note.path)), mentions })
}

/** An invitation answered or a notice seen: off the list at once, then asked again. */
export async function answerNotice(id: number, accept: boolean): Promise<string | null> {
  publish({ ...state, notices: state.notices.filter((notice) => notice.id !== id) })
  try {
    return accept ? (await noticesApi.accept(id)).space : (await noticesApi.decline(id), null)
  } finally {
    await refreshNews()
  }
}

export async function seenAll(): Promise<void> {
  // Invitations wait for an answer; what the operator did counts as seen now.
  const told = state.notices.filter((notice) => notice.kind !== 'invite')
  publish({ count: 0, notes: [], paths: new Set(), mentions: [], notices: state.notices.filter((notice) => notice.kind === 'invite'), requests: state.requests })
  await Promise.all([newsApi.seenAll(), ...told.map((notice) => noticesApi.decline(notice.id).catch(() => undefined))])
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

// Decided on the approvals page: the list here follows at once.
if (typeof window !== 'undefined') window.addEventListener(REQUESTS_EVENT, () => void refreshNews())
