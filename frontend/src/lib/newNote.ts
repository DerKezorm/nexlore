/**
 * "New note" is asked for from the sidebar and from the header on a phone, and shown by the app's frame (AppShell):
 * a page that renders its sidebar anew while it loads (the note page) must not lose a dialog that was just opened.
 */
export const NEW_NOTE_EVENT = 'nexlore:new-note'

export function askNewNote(folder: string): void {
  window.dispatchEvent(new CustomEvent<string>(NEW_NOTE_EVENT, { detail: folder }))
}
