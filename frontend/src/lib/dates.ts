/**
 * Dates in words, German and English: "morgen", "nächsten Freitag", "in 3 Tagen", "tomorrow", "next friday",
 * "in 2 weeks", "1.10." and the like, as the editor offers them after "@" (`editor/dateSuggest.ts`). A weekday alone
 * means the next one after today; "next week" its Monday, "next month" its first day.
 */

export type DateWord = { phrase: string; date: Date }

const DAY_MS = 86_400_000

function atNoon(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12)
}

function plusDays(date: Date, days: number): Date {
  return atNoon(new Date(atNoon(date).getTime() + days * DAY_MS))
}

function plusMonths(date: Date, months: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth() + months, 1, 12)
  const last = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()
  return new Date(next.getFullYear(), next.getMonth(), Math.min(date.getDate(), last), 12)
}

/** Monday is 0. */
const weekday = (date: Date) => (date.getDay() + 6) % 7

const WEEKDAYS: Record<string, number> = {
  montag: 0, dienstag: 1, mittwoch: 2, donnerstag: 3, freitag: 4, samstag: 5, sonntag: 6,
  monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6,
}

/** Words that stand alone, offered while typed: the day they mean from `today`. */
const FIXED: Record<string, (today: Date) => Date> = {
  heute: (today) => atNoon(today),
  morgen: (today) => plusDays(today, 1),
  übermorgen: (today) => plusDays(today, 2),
  gestern: (today) => plusDays(today, -1),
  vorgestern: (today) => plusDays(today, -2),
  'nächste woche': (today) => plusDays(today, 7 - weekday(today)),
  'nächsten monat': (today) => new Date(today.getFullYear(), today.getMonth() + 1, 1, 12),
  today: (today) => atNoon(today),
  tomorrow: (today) => plusDays(today, 1),
  'day after tomorrow': (today) => plusDays(today, 2),
  yesterday: (today) => plusDays(today, -1),
  'next week': (today) => plusDays(today, 7 - weekday(today)),
  'next month': (today) => new Date(today.getFullYear(), today.getMonth() + 1, 1, 12),
}

const UNITS: Record<string, 'day' | 'week' | 'month' | 'year'> = {
  tag: 'day', tage: 'day', tagen: 'day', woche: 'week', wochen: 'week', monat: 'month', monate: 'month', monaten: 'month',
  jahr: 'year', jahre: 'year', jahren: 'year',
  day: 'day', days: 'day', week: 'week', weeks: 'week', month: 'month', months: 'month', year: 'year', years: 'year',
}

function shift(today: Date, amount: number, unit: 'day' | 'week' | 'month' | 'year'): Date {
  if (unit === 'day') return plusDays(today, amount)
  if (unit === 'week') return plusDays(today, amount * 7)
  if (unit === 'month') return plusMonths(today, amount)
  return plusMonths(today, amount * 12)
}

function valid(year: number, month: number, day: number): Date | null {
  const date = new Date(year, month - 1, day, 12)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null
}

/** The day a phrase means, from `today`; null when it is none. */
export function parseDateWords(phrase: string, today: Date): Date | null {
  const text = phrase.trim().toLocaleLowerCase('de').replace(/\s+/g, ' ')
  if (!text) return null
  if (FIXED[text]) return FIXED[text](today)
  const day = /^(?:(?:nächsten|nächster|kommenden|next|this|diesen|am)\s+)?([a-zäöü]+)$/.exec(text)
  if (day && day[1] in WEEKDAYS) {
    const ahead = (WEEKDAYS[day[1]] - weekday(today) + 7) % 7 || 7
    return plusDays(today, ahead)
  }
  const ahead = /^in (\d{1,3}) ([a-zäöü]+)$/.exec(text)
  if (ahead && ahead[2] in UNITS) return shift(today, Number(ahead[1]), UNITS[ahead[2]])
  const back = /^(?:vor (\d{1,3}) ([a-zäöü]+)|(\d{1,3}) ([a-z]+) ago)$/.exec(text)
  if (back) {
    const [amount, unit] = back[1] ? [back[1], back[2]] : [back[3], back[4]]
    if (unit in UNITS) return shift(today, -Number(amount), UNITS[unit])
  }
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)
  if (iso) return valid(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  const german = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})?$/.exec(text)
  if (german) {
    const year = german[3] ? (german[3].length === 2 ? 2000 + Number(german[3]) : Number(german[3])) : today.getFullYear()
    return valid(year, Number(german[2]), Number(german[1]))
  }
  return null
}

/** `2026-10-01`, as daily notes are named. */
export function isoDate(date: Date): string {
  const two = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
}

/** The phrases that fit what is typed after "@": complete words while typed, and the words as they stand. */
export function dateWords(typed: string, today: Date, limit = 5): DateWord[] {
  const text = typed.trim().toLocaleLowerCase('de')
  if (!text) return []
  const found: DateWord[] = []
  const exact = parseDateWords(text, today)
  if (exact) found.push({ phrase: typed.trim(), date: exact })
  const names = [...Object.keys(FIXED), ...Object.keys(WEEKDAYS)]
  for (const name of names) {
    if (found.length >= limit) break
    if (name === text || !name.startsWith(text)) continue
    found.push({ phrase: name, date: parseDateWords(name, today)! })
  }
  return found
}
