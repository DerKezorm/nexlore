/**
 * Opens a modal `<dialog>` once. React runs effects twice in development (StrictMode), and a second `showModal()` on
 * an open dialog throws.
 */
export function showModalOnce(dialog: HTMLDialogElement | null): void {
  if (!dialog || dialog.open) return
  // Where the focus was: it goes back there when the dialog is taken off the page (it fell to the page itself, review
  // P8.13). Closing it on the page needs nothing: the browser gives the focus back by itself then.
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  dialog.showModal()
  if (!opener) return
  const back = () => {
    if (opener.isConnected && (document.activeElement === document.body || document.activeElement === null)) opener.focus()
  }
  const watcher = new MutationObserver(() => {
    if (dialog.isConnected) return
    watcher.disconnect()
    back()
  })
  if (dialog.parentNode) watcher.observe(dialog.parentNode, { childList: true })
}
