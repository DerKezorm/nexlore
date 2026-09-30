/**
 * How often each entry of the slash menu was chosen, in this browser: the menu shows the ones used most first within
 * their group (ties keep their place, so a menu used little does not move).
 */

const KEY = 'nexlore.slashUse'

function read(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    if (!raw || typeof raw !== 'object') return {}
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
  } catch {
    return {}
  }
}

export function noteSlashUse(key: string): void {
  const counts = read()
  counts[key] = (counts[key] ?? 0) + 1
  try {
    localStorage.setItem(KEY, JSON.stringify(counts))
  } catch {
    // Not kept: the menu stays in its order.
  }
}

/** `items` ordered by use, most first; the same count keeps the order it came in. */
export function byUse<T extends { key: string }>(items: T[]): T[] {
  const counts = read()
  return items
    .map((item, index) => ({ item, index, used: counts[item.key] ?? 0 }))
    .sort((a, b) => b.used - a.used || a.index - b.index)
    .map(({ item }) => item)
}
