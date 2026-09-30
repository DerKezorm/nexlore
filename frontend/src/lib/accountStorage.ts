/**
 * What the browser remembers that names notes or spaces (tabs, folds, the chosen space) belongs to the account, not
 * to the browser: on a shared computer the next account must not see the titles of the one before. Each such key gets
 * the account's id at its end; toolbar, sidebar and similar switches stay per browser.
 */

/** The keys before 1.0.0 had no account in them; they are dropped once, unread. */
export const ACCOUNT_KEYS = [
  'nexlore.tabs',
  'nexlore.tabsPinned',
  'nexlore.folds',
  'nexlore.daily.space',
  'nexlore.captureSpace',
  'nexlore.cleanupSpace',
] as const

let owner = 'none'

/** Who is signed in; `null` after signing out, so nothing is read or written for anybody. */
export function setStorageOwner(id: number | null): void {
  owner = id === null ? 'none' : String(id)
}

/** ``key`` for the account signed in. */
export function ownKey(key: string): string {
  return `${key}.${owner}`
}

export function forgetSharedKeys(): void {
  for (const key of ACCOUNT_KEYS) {
    try {
      localStorage.removeItem(key)
    } catch {
      // Storage blocked: there is nothing to forget either.
    }
  }
}
