import { useSyncExternalStore } from 'react'

/**
 * "New note" is asked for from the sidebar and from the header on a phone, and shown by the app's frame (AppShell):
 * a page that renders its sidebar anew while it loads (the note page) must not lose a dialog that was just opened.
 */
export const NEW_NOTE_EVENT = 'nexlore:new-note'

export function askNewNote(folder: string): void {
  window.dispatchEvent(new CustomEvent<string>(NEW_NOTE_EVENT, { detail: folder }))
}

/**
 * "New note" without a folder of its own (the button at the top of every sidebar, Alt+N): the app's frame knows where a
 * new note goes, the open note's folder or the main space.
 */
export const NEW_NOTE_HERE_EVENT = 'nexlore:new-note-here'

let here: string | null = null
const listeners = new Set<() => void>()

/** The app's frame says where a new note goes now (null: nowhere, the account has no space to write in). */
export function setNewNoteTarget(folder: string | null): void {
  if (folder === here) return
  here = folder
  for (const listener of listeners) listener()
}

/** Where a new note goes now, for the button at the top of a sidebar: without a place it stands disabled. */
export function useNewNoteTarget(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => here,
  )
}

export function askNewNoteHere(): void {
  window.dispatchEvent(new CustomEvent(NEW_NOTE_HERE_EVENT))
}
