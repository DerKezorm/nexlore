/**
 * Requests to the app frame from anywhere on a page: open the search, open the list of notes. On a phone the sidebar
 * is not on the screen; it comes as a sheet from the left when asked for.
 */

export const SEARCH_EVENT = 'nexlore:search'
export const NOTE_LIST_EVENT = 'nexlore:note-list'

/** Below this width the sidebar is a sheet (Tailwind's `md`). */
export const SHEET_BELOW = 768

/** When the list of notes was asked for last; 0: not now. */
let pendingList = 0
/** A wish that old is forgotten: the page it was for has long been drawn. */
const LIST_WISH_MS = 20_000

export function askSearch(): void {
  window.dispatchEvent(new CustomEvent(SEARCH_EVENT))
}

/** Opens the list of notes; a page that shows its sidebar only after the next navigation finds the wish waiting. */
export function askNoteList(): void {
  pendingList = Date.now()
  window.dispatchEvent(new CustomEvent(NOTE_LIST_EVENT))
}

/**
 * Whether the list was asked for a moment ago. Not taken on the first look: a page still loading draws its sidebar,
 * drops it and draws it again (seen on a slow phone: the list never came), and the second one must find the wish too.
 * It goes when the list is closed, or after a few seconds.
 */
export function noteListWished(): boolean {
  return pendingList > 0 && Date.now() - pendingList < LIST_WISH_MS
}

export function forgetNoteListWish(): void {
  pendingList = 0
}

export function narrow(): boolean {
  return typeof window !== 'undefined' && window.innerWidth < SHEET_BELOW
}

export const FOLDER_EVENT = 'nexlore:show-folder'

let pendingFolder: string | null = null
let sidebars = 0

/** A sidebar on the page counts itself (the returned function uncounts it), so a folder asked for on a page without
 * one is shown on a page that has one. */
export function sidebarHere(): () => void {
  sidebars += 1
  return () => {
    sidebars -= 1
  }
}

export function hasSidebar(): boolean {
  return sidebars > 0
}

/** Shows a folder in the sidebar: it and the folders on its way open, scrolled to and focused (on a phone in the
 * sheet). A sidebar that mounts only after the next navigation finds the wish waiting. */
/** A folder, or a note or file (a card on a canvas), opened in the sidebar and scrolled to. */
export function askFolder(path: string): void {
  pendingFolder = path
  window.dispatchEvent(new CustomEvent(FOLDER_EVENT))
}

export function takeFolderWish(): string | null {
  const wish = pendingFolder
  pendingFolder = null
  return wish
}

/** The note in front (the left pane): the quick switcher offers its headings after `#`. */
export type ShownNote = { path: string; read: () => string }
let shown: ShownNote | null = null

export function setShownNote(note: ShownNote | null): void {
  shown = note
}

export function shownNote(): ShownNote | null {
  return shown
}

export const HEADING_EVENT = 'nexlore:heading'

/** Scrolls the note in front to a heading (its text, and which of the headings it is if the text is not found). */
export function askHeading(text: string, index: number): void {
  window.dispatchEvent(new CustomEvent<{ text: string; index: number }>(HEADING_EVENT, { detail: { text, index } }))
}

export const SIDEBAR_EVENT = 'nexlore:toggle-sidebar'
/** A note was told to the server as opened: the list of notes opened last is read again. */
export const RECENT_EVENT = 'nexlore:recent'
export const PANEL_EVENT = 'nexlore:toggle-panel'

/** Folds the sidebar to its strip of symbols or opens it (on a phone: the sheet); Alt+B and the command palette. */
export function askSidebarToggle(): void {
  window.dispatchEvent(new CustomEvent(SIDEBAR_EVENT))
}

/** Shows or hides the column beside the note (below 1280 pixels: the sheet); Alt+R and the command palette. */
export function askPanelToggle(): void {
  window.dispatchEvent(new CustomEvent(PANEL_EVENT))
}
