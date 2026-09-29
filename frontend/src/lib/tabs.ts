/**
 * Tabs for notes, as in Obsidian: the note page shows a row of the notes open. Opening a note (the sidebar, a link)
 * shows it in the tab in front; "Open in a new tab", a click with Ctrl or Cmd, or the middle button opens another.
 * Remembered in this browser (like the toolbar), because tabs belong to the screen one works at, not to the account.
 */
import { noteUrl } from './vault'

const KEY = 'nexlore.tabs'
export const TABS_EVENT = 'nexlore:tabs'
/** More than this many tabs: the oldest one left of the front tab goes. */
export const MAX_TABS = 20

export type Tabs = { paths: string[]; active: number }

const EMPTY: Tabs = { paths: [], active: 0 }

export function readTabs(): Tabs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Tabs | null
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
    localStorage.setItem(KEY, JSON.stringify(tabs))
  } catch {
    // Not remembered (private window, blocked storage): the tabs last as long as the page.
  }
  window.dispatchEvent(new CustomEvent(TABS_EVENT))
  return tabs
}

/** The note page shows `path`: its tab comes to the front, or it takes the place of the tab in front. */
export function followTab(path: string): Tabs {
  const tabs = readTabs()
  const at = tabs.paths.indexOf(path)
  if (at >= 0) return tabs.active === at ? tabs : writeTabs({ ...tabs, active: at })
  if (!tabs.paths.length) return writeTabs({ paths: [path], active: 0 })
  const paths = [...tabs.paths]
  paths[tabs.active] = path
  return writeTabs({ paths, active: tabs.active })
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
