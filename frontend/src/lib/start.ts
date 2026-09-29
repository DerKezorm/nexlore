/**
 * The start page of the account (Settings → General): taken once per tab, when nexlore is opened on its first page
 * (`/` without anything after it). Later visits to the map stay on the map.
 */

const KEY = 'nexlore.started'

/** Decided once per page load (a render may run twice), then kept until the wish is taken. */
let wish: boolean | null = null

/** Whether this tab is still to go to the start page. */
export function startWish(pathname: string, search: string): boolean {
  if (wish === null) {
    let started = false
    try {
      started = sessionStorage.getItem(KEY) === '1'
      sessionStorage.setItem(KEY, '1')
    } catch {
      // Without the tab's storage: the first page of this load decides, which comes to the same.
    }
    wish = !started && pathname === '/' && !search
  }
  return wish
}

export function startTaken(): void {
  wish = false
}
