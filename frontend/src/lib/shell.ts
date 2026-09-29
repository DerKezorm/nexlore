/**
 * Requests to the app frame from anywhere on a page: open the search, open the list of notes. On a phone the sidebar
 * is not on the screen; it comes as a sheet from the left when asked for.
 */

export const SEARCH_EVENT = 'nexlore:search'
export const NOTE_LIST_EVENT = 'nexlore:note-list'

/** Below this width the sidebar is a sheet (Tailwind's `md`). */
export const SHEET_BELOW = 768

let pendingList = false

export function askSearch(): void {
  window.dispatchEvent(new CustomEvent(SEARCH_EVENT))
}

/** Opens the list of notes; a page that shows its sidebar only after the next navigation finds the wish waiting. */
export function askNoteList(): void {
  pendingList = true
  window.dispatchEvent(new CustomEvent(NOTE_LIST_EVENT))
}

/** A sidebar that mounts takes a waiting wish, once. */
export function takeNoteListWish(): boolean {
  const wish = pendingList
  pendingList = false
  return wish
}

export function narrow(): boolean {
  return typeof window !== 'undefined' && window.innerWidth < SHEET_BELOW
}
