/**
 * How a space names its daily notes (`YYYY-MM-DD` unless its managers chose another, `DD.MM.YYYY`): the same rules as
 * `backend/app/services/dayname.py`. Only the numbers of a date: `YYYY`, `YY`, `MM`, `M`, `DD`, `D`; `[text]` as it
 * stands; `/` makes a folder.
 */
export const DEFAULT_DAY_NAME = 'YYYY-MM-DD'

const TOKEN = /\[[^\]]*\]|YYYY|YY|MM|M|DD|D|[\s\S]/g
const NUMBERS: Record<string, string> = {
  YYYY: '(?<Y>\\d{4})',
  YY: '(?<y>\\d{2})',
  MM: '(?<M>\\d{2})',
  M: '(?<M>\\d{1,2})',
  DD: '(?<D>\\d{2})',
  D: '(?<D>\\d{1,2})',
}

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

/** The day a name stands for (`02.10.2026` gives `2026-10-02`), or null when it is none in this pattern. */
export function dayOfName(pattern: string | undefined, name: string): string | null {
  const source = (pattern || DEFAULT_DAY_NAME).replace(TOKEN, (token) =>
    token.startsWith('[') ? escapeRe(token.slice(1, -1)) : (NUMBERS[token] ?? escapeRe(token)),
  )
  let found: RegExpMatchArray | null
  try {
    found = new RegExp(`^${source}$`, 'i').exec(name.trim())
  } catch {
    return null
  }
  const groups = found?.groups
  if (!groups) return null
  const year = groups.Y ? Number(groups.Y) : 2000 + Number(groups.y)
  const month = Number(groups.M)
  const date = Number(groups.D)
  const check = new Date(Date.UTC(year, month - 1, date))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null
  return `${pad(year, 4)}-${pad(month)}-${pad(date)}`
}
