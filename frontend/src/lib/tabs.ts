/**
 * Tabs for notes, as in Obsidian: the note page shows a row of the notes open. Opening a note (the sidebar, a link)
 * shows it in the tab in front; "Open in a new tab", a click with Ctrl or Cmd, or the middle button opens another.
 * Remembered in this browser and for the account signed in (`ownKey`): another account on the same browser has its
 * own tabs and never sees these titles.
 *
 * A pinned tab stays: it stands left of the others, has no cross, and a note opened from it comes in a tab of its own
 * instead of taking its place. Kept apart from the list (`nexlore.tabsPinned`), so the list keeps its old shape.
 */
import { ownKey } from './accountStorage'
import { noteUrl } from './vault'

const KEY = 'nexlore.tabs'
const PINNED_KEY = 'nexlore.tabsPinned'
export const TABS_EVENT = 'nexlore:tabs'
/** More than this many tabs: the oldest one left of the front tab goes. */
export const MAX_TABS = 20

export type Tabs = { paths: string[]; active: number }

const EMPTY: Tabs = { paths: [], active: 0 }

export function readTabs(): Tabs {
  try {
    const raw = JSON.parse(localStorage.getItem(ownKey(KEY)) ?? 'null') as Tabs | null
    if (!raw || !Array.isArray(raw.paths)) return EMPTY
    const paths = raw.paths.filter((path): path is string => typeof path === 'string' && path.length > 0).slice(0, MAX_TABS)
    const active = Number.isInteger(raw.active) ? Math.min(Math.max(0, raw.active), Math.max(0, paths.length - 1)) : 0
    return { paths, active }
  } catch {
    return EMPTY
  }
}

function writeTabs(tabs: Tabs): Tabs {
  try {
    localStorage.setItem(ownKey(KEY), JSON.stringify(tabs))
  } catch {
    // Not remembered (private window, blocked storage): the tabs last as long as the page.
  }
  window.dispatchEvent(new CustomEvent(TABS_EVENT))
  return tabs
}

/** The pinned tabs, those still open. */
export function readPinned(): string[] {
  const open = new Set(readTabs().paths)
  try {
    const raw = JSON.parse(localStorage.getItem(ownKey(PINNED_KEY)) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((path): path is string => typeof path === 'string' && open.has(path)) : []
  } catch {
    return []
  }
}

function writePinned(pinned: string[]): void {
  try {
    localStorage.setItem(ownKey(PINNED_KEY), JSON.stringify(pinned))
  } catch {
    // Not remembered: pinned as long as the page lasts.
  }
}

/** The note page shows `path`: its tab comes to the front, or it takes the place of the tab in front (a pinned one
 * keeps its note: the new one comes in a tab right after it). */
export function followTab(path: string): Tabs {
  const tabs = readTabs()
  const at = tabs.paths.indexOf(path)
  if (at >= 0) return tabs.active === at ? tabs : writeTabs({ ...tabs, active: at })
  if (!tabs.paths.length) return writeTabs({ paths: [path], active: 0 })
  const paths = [...tabs.paths]
  if (readPinned().includes(paths[tabs.active])) {
    const place = Math.max(tabs.active, lastPinned(paths)) + 1
    paths.splice(place, 0, path)
    if (paths.length > MAX_TABS) {
      const oldest = paths.findIndex((item, index) => index !== place && !readPinned().includes(item))
      paths.splice(oldest, 1)
      return writeTabs({ paths, active: oldest < place ? place - 1 : place })
    }
    return writeTabs({ paths, active: place })
  }
  paths[tabs.active] = path
  return writeTabs({ paths, active: tabs.active })
}

function lastPinned(paths: string[]): number {
  const pinned = readPinned()
  let last = -1
  paths.forEach((item, index) => pinned.includes(item) && (last = index))
  return last
}

/** Pins a tab (it moves after the other pinned ones) or lets it go again (it moves after the pinned ones). */
export function pinTab(path: string, pin: boolean): void {
  const tabs = readTabs()
  if (!tabs.paths.includes(path)) return
  const shown = tabs.paths[tabs.active]
  const pinned = readPinned().filter((item) => item !== path)
  if (pin) pinned.push(path)
  writePinned(pinned)
  // Pinned ones first, in the order they were pinned; the rest as they stood.
  const paths = [...pinned, ...tabs.paths.filter((item) => !pinned.includes(item))]
  writeTabs({ paths, active: paths.indexOf(shown) })
}

/** Moves a tab to `to` (its new place in the row); a pinned tab stays among the pinned, another among the others. */
export function moveTab(path: string, to: number): void {
  const tabs = readTabs()
  const from = tabs.paths.indexOf(path)
  if (from < 0) return
  const shown = tabs.paths[tabs.active]
  const pinned = readPinned()
  const pins = tabs.paths.filter((item) => pinned.includes(item)).length
  const paths = tabs.paths.filter((item) => item !== path)
  const place = pinned.includes(path) ? Math.min(Math.max(0, to), pins - 1) : Math.min(Math.max(pins, to), paths.length)
  paths.splice(place, 0, path)
  if (pinned.includes(path)) writePinned(paths.filter((item) => pinned.includes(item)))
  writeTabs({ paths, active: paths.indexOf(shown) })
}

/** Closes every tab but `keep` and the pinned ones. */
export function closeOtherTabs(keep: string): void {
  const tabs = readTabs()
  const pinned = readPinned()
  const paths = tabs.paths.filter((item) => item === keep || pinned.includes(item))
  writeTabs({ paths, active: Math.max(0, paths.indexOf(keep)) })
}

/** A new tab right after the one in front, then shown. */
export function openInTab(path: string, go: (url: string) => void): void {
  const tabs = readTabs()
  const at = tabs.paths.indexOf(path)
  if (at >= 0) writeTabs({ ...tabs, active: at })
  else {
    const paths = [...tabs.paths]
    const place = paths.length ? tabs.active + 1 : 0
    paths.splice(place, 0, path)
    let active = place
    if (paths.length > MAX_TABS) {
      paths.splice(0, 1)
      active -= 1
    }
    writeTabs({ paths, active })
  }
  go(noteUrl(path))
}

/**
 * Closes a tab. `front` says whether it was the one in front, and then `next` is the note to show now (the one to its
 * right, else to its left), or null when none is left.
 *
 * `shown`: the note on the screen. It decides what is in front, not the stored mark: that follows a new address only
 * after the page has drawn, and a click on × in between closed the tab and left its note standing (Windows CI).
 */
export function closeTab(path: string, shown?: string): { front: boolean; next: string | null } {
  const tabs = readTabs()
  const at = tabs.paths.indexOf(path)
  if (at < 0) return { front: false, next: null }
  const paths = tabs.paths.filter((_, index) => index !== at)
  writePinned(readPinned().filter((item) => item !== path))
  const front = shown !== undefined ? path === shown : at === tabs.active
  const still = shown !== undefined && !front ? paths.indexOf(shown) : -1
  const active = Math.max(0, front ? Math.min(at, paths.length - 1) : still >= 0 ? still : tabs.active - (at < tabs.active ? 1 : 0))
  writeTabs({ paths, active })
  return { front, next: front ? (paths[active] ?? null) : null }
}

/** A note or folder moved or went into the trash: its tabs (and those of what lay in it) go, unless in front. */
export function forgetTabs(path: string, front: string | null): void {
  const tabs = readTabs()
  const keep = tabs.paths.filter((item) => item === front || !(item === path || item.startsWith(path + '/')))
  if (keep.length === tabs.paths.length) return
  const active = front ? Math.max(0, keep.indexOf(front)) : 0
  writeTabs({ paths: keep, active })
}
