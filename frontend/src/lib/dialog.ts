/**
 * Opens a modal `<dialog>` once. React runs effects twice in development (StrictMode), and a second `showModal()` on
 * an open dialog throws.
 */
export function showModalOnce(dialog: HTMLDialogElement | null): void {
  if (dialog && !dialog.open) dialog.showModal()
}
