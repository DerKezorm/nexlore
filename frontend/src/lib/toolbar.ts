/** The editor's toolbar: whether it is hidden in this browser, and the kinds of callout it offers. */

const HIDDEN_KEY = 'nexlore.editorToolbar'

/** The kinds of callout Obsidian knows, the common ones first. */
export const CALLOUTS = ['note', 'tip', 'info', 'warning', 'danger', 'question', 'example', 'quote', 'success', 'failure', 'bug', 'todo', 'abstract'] as const

export function toolbarHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === 'hidden'
  } catch {
    return false
  }
}

export function rememberToolbar(hidden: boolean) {
  try {
    if (hidden) localStorage.setItem(HIDDEN_KEY, 'hidden')
    else localStorage.removeItem(HIDDEN_KEY)
  } catch {
    // Not remembered (private window, blocked storage): it is shown again next time.
  }
}
