/**
 * How a space names its daily notes (`YYYY-MM-DD` unless its managers chose another, `DD.MM.YYYY`): the same rules as
 * `backend/app/services/dayname.py`. Only the numbers of a date: `YYYY`, `YY`, `MM`, `M`, `DD`, `D`; `[text]` as it
 * stands; `/` makes a folder.
 */
export const DEFAULT_DAY_NAME = 'YYYY-MM-DD'

const TOKEN = /\[[^\]]*\]|YYYY|YY|MM|M|DD|D|[\s\S]/g
const NUMBERS: Record<string, string> = { YYYY: '(\\d{4})', YY: '(\\d{2})', MM: '(\\d{2})', M: '(\\d{1,2})', DD: '(\\d{2})', D: '(\\d{1,2})' }

const pad = (value: number, size = 2) => String(value).padStart(size, '0')

/** The name of the daily note of `day` (`2026-10-02`), without `.md`. */
export function dayName(pattern: string | undefined, day: string): string {
  const [year, month, date] = day.split('-').map(Number)
  return (pattern || DEFAULT_DAY_NAME).replace(TOKEN, (token) => {
    if (token.startsWith('[')) return token.slice(1, -1)
    switch (token) {
      case 'YYYY':
        return pad(year, 4)
      case 'YY':
        return pad(year % 100)
      case 'MM':
        return pad(month)
      case 'M':
        return String(month)
      case 'DD':
        return pad(date)
      case 'D':
        return String(date)
      default:
        return token
    }
  })
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/**
 * The day a name stands for (`02.10.2026` gives `2026-10-02`), or null when it is none in this pattern. A part named
 * twice (`YYYY/MM/YYYY-MM-DD`) must say the same both times.
 */
export function dayOfName(pattern: string | undefined, name: string): string | null {
  const tokens: string[] = []
  const source = (pattern || DEFAULT_DAY_NAME).replace(TOKEN, (token) => {
    if (token.startsWith('[')) return escapeRe(token.slice(1, -1))
    if (NUMBERS[token]) {
      tokens.push(token)
      return NUMBERS[token]
    }
    return escapeRe(token)
  })
  let found: RegExpExecArray | null
  try {
    found = new RegExp(`^${source}$`, 'i').exec(name.trim())
  } catch {
    return null
  }
  if (!found) return null
  const values: Record<string, Set<number>> = { Y: new Set(), M: new Set(), D: new Set() }
  tokens.forEach((token, index) => {
    const number = Number(found![index + 1])
    values[token[0]].add(token === 'YY' ? 2000 + number : number)
  })
  if (Object.values(values).some((set) => set.size !== 1)) return null
  const [year, month, date] = (['Y', 'M', 'D'] as const).map((key) => [...values[key]][0])
  const check = new Date(Date.UTC(year, month - 1, date))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null
  return `${pad(year, 4)}-${pad(month)}-${pad(date)}`
}

/**
 * The day a daily note stands for, or null when the note is none: named in its space's pattern, in the space's daily
 * folder (below it too, for a pattern without folders). As `daily_day` on the server.
 */
export function dailyDayOf(path: string, folder: string | undefined, pattern: string | undefined): string | null {
  if (!/\.md$/i.test(path)) return null
  let within = path.includes('/') ? path.slice(path.indexOf('/') + 1) : path
  if (folder) {
    if (!within.toLowerCase().startsWith(folder.toLowerCase() + '/')) return null
    within = within.slice(folder.length + 1)
  }
  const stem = within.replace(/\.md$/i, '')
  const found = dayOfName(pattern, stem)
  if (found === null && !(pattern || DEFAULT_DAY_NAME).includes('/') && stem.includes('/')) return dayOfName(pattern, stem.slice(stem.lastIndexOf('/') + 1))
  return found
}
