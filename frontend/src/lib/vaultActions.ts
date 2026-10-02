/**
 * What the context menus ask for (a new folder, renaming, moving, the trash) and what the note page is told before a
 * note goes or moves. The dialogs live in the app's frame (`VaultActions`), like "New note": a page that draws its
 * sidebar anew while it loads must not lose a dialog that was just opened.
 */

export type VaultAction =
  | { kind: 'new-folder'; parent: string }
  | { kind: 'new-space' }
  | { kind: 'look'; path: string }
  | { kind: 'as-template'; path: string }
  | { kind: 'rename' | 'move' | 'delete'; path: string; folder: boolean; file?: boolean }
  | { kind: 'rename-tag'; tag: string }
  | { kind: 'new-base'; folder: string }
  /** Dragged onto a folder in the sidebar: moved at once, said as the dialog says it. */
  | { kind: 'move-to'; path: string; target: string }

export const VAULT_ACTION_EVENT = 'nexlore:vault-action'

export function askVaultAction(action: VaultAction): void {
  window.dispatchEvent(new CustomEvent<VaultAction>(VAULT_ACTION_EVENT, { detail: action }))
}

/**
 * Sent just before a note or folder moves or goes. A page showing it (or a note inside it) stops asking after the old
 * path, and a note being edited is saved first: `wait` takes that save, and the move waits for it.
 */
export const LEAVING_EVENT = 'nexlore:leaving'
export type Leaving = { path: string; wait: (done: Promise<unknown>) => void }

export async function announceLeaving(path: string): Promise<void> {
  const waits: Promise<unknown>[] = []
  window.dispatchEvent(new CustomEvent<Leaving>(LEAVING_EVENT, { detail: { path, wait: (done) => waits.push(done) } }))
  await Promise.allSettled(waits)
}

/** Whether `path` is `root` itself or lies inside it. */
export function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root + '/')
}

/** A folder moved away or trashed: the sidebar forgets what it read of it, instead of asking after it again. */
export const FORGET_EVENT = 'nexlore:forget'

export function forget(path: string): void {
  window.dispatchEvent(new CustomEvent<string>(FORGET_EVENT, { detail: path }))
}

/** A folder to show open in the sidebar (a folder just made, and the folders on its way). */
export const REVEAL_EVENT = 'nexlore:reveal'

export function reveal(path: string): void {
  window.dispatchEvent(new CustomEvent<string>(REVEAL_EVENT, { detail: path }))
}

/** Text to the clipboard; without a secure page (plain http) through a hidden field, the way browsers still allow. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Falls through to the old way.
  }
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.append(field)
  field.select()
  try {
    return document.execCommand('copy')
  } finally {
    field.remove()
  }
}
