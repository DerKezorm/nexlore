/** The editor's toolbar: whether it is hidden in this browser, and the kinds of callout it offers. */

const HIDDEN_KEY = 'nexlore.editorToolbar'
const LINES_KEY = 'nexlore.lineNumbers'

/** The kinds of callout Obsidian knows, the common ones first. */
export const CALLOUTS = ['note', 'tip', 'info', 'warning', 'danger', 'question', 'example', 'quote', 'success', 'failure', 'bug', 'todo', 'abstract'] as const

export function toolbarHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === 'hidden'
  } catch {
    return false
  }
}

/** Whether the file's line numbers stand beside the text, in this browser; off from the start. */
export function linesShown(): boolean {
  try {
    return localStorage.getItem(LINES_KEY) === 'on'
  } catch {
    return false
  }
}

export function rememberLines(on: boolean) {
  try {
    if (on) localStorage.setItem(LINES_KEY, 'on')
    else localStorage.removeItem(LINES_KEY)
  } catch {
    // Not remembered: off again next time.
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
