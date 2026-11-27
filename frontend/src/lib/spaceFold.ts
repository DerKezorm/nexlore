/**
 * Which spaces of the sidebar were folded by hand, remembered in this browser like the sidebar's other switches. The
 * tree is drawn anew for every note (the note page keys it by the note), so without this every space opened again at
 * the next note, and again after a reload (GitHub issue 22). Only spaces are kept: a folder inside one opens on the
 * way to the note shown and closes when the next note lies elsewhere. Opening a note in a folded space unfolds that
 * space alone, and from then on it stays open.
 */

const KEY = 'nexlore.closedSpaces'

/** The spaces folded by hand, as the tree's map of switched rows (`false`: closed). */
export function storedFolds(): Map<string, boolean> {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(list)) return new Map()
    const names = list.filter((name): name is string => typeof name === 'string' && name !== '' && !name.includes('/'))
    return new Map(names.map((name) => [name, false]))
  } catch {
    return new Map()
  }
}

/** Keeps the closed spaces of the tree's map of switched rows; folders inside spaces are not kept. */
export function keepFolds(toggled: Map<string, boolean>): void {
  const closed = [...toggled]
    .filter(([path, open]) => !open && !path.includes('/'))
    .map(([path]) => path)
    .sort()
  try {
    if (closed.length) localStorage.setItem(KEY, JSON.stringify(closed))
    else localStorage.removeItem(KEY)
  } catch {
    // Storage blocked: the folds hold until the page is left.
  }
}
