/**
 * Dates and groups for everyday use (M6): the calendar's month, a task's group in the overview, the space daily
 * notes go to. Dates travel as `JJJJ-MM-TT` in the browser's own time: "today" is the reader's today, not the server's.
 */
import type { Space, TaskItem, TaskWhen } from '../api/client'

/** `JJJJ-MM-TT` of a day in local time. */
export function isoDay(day: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}

export function today(): string {
  return isoDay(new Date())
}

/** A date at noon, so that no time zone and no change to summer time moves it to another day. */
export function atNoon(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number)
  return new Date(year, month - 1, day, 12)
}

export function addDays(iso: string, days: number): string {
  const day = atNoon(iso)
  day.setDate(day.getDate() + days)
  return isoDay(day)
}

/** `JJJJ-MM` of a date, and the month before or after it. */
export function monthOf(iso: string): string {
  return iso.slice(0, 7)
}

export function shiftMonth(month: string, by: number): string {
  const [year, number] = month.split('-').map(Number)
  const day = new Date(year, number - 1 + by, 1, 12)
  return isoDay(day).slice(0, 7)
}

export function lastDay(month: string): string {
  const [year, number] = month.split('-').map(Number)
  return isoDay(new Date(year, number, 0, 12))
}

/** The weeks of a month, Monday first, each seven days; days of other months are null. */
export function monthGrid(month: string, weekStart: 'monday' | 'sunday' = 'monday'): (string | null)[][] {
  const first = atNoon(month + '-01')
  const lead = weekStart === 'sunday' ? first.getDay() : (first.getDay() + 6) % 7
  const days: (string | null)[] = Array.from({ length: lead }, () => null)
  const end = Number(lastDay(month).slice(8))
  for (let day = 1; day <= end; day++) days.push(`${month}-${String(day).padStart(2, '0')}`)
  while (days.length % 7) days.push(null)
  const weeks: (string | null)[][] = []
  for (let start = 0; start < days.length; start += 7) weeks.push(days.slice(start, start + 7))
  return weeks
}

/** The day a task belongs to: its due date, else its scheduled date. */
export function dayOf(task: Pick<TaskItem, 'due' | 'scheduled'>): string | null {
  return task.due ?? task.scheduled
}

/** Which group of the overview an open task stands in, the way the server counts them. */
export function whenOf(task: Pick<TaskItem, 'due' | 'scheduled'>, now: string): TaskWhen {
  const day = dayOf(task)
  if (!day) return 'none'
  if (day < now) return 'overdue'
  if (day === now) return 'today'
  return day <= addDays(now, 6) ? 'week' : 'later'
}

export const PRIORITY_MARK: Record<number, string> = { 5: '🔺', 4: '⏫', 3: '🔼', 1: '🔽', 0: '⏬' }

/**
 * Where "Today", quick capture and a new note go: the space of the note open now, when the account may write in it;
 * else its main space (Settings, General); else its first own space; else the first it may write in (P5.19).
 */
export function homeSpace(spaces: Space[], chosen?: string | null, open?: string | null): Space | null {
  const writable = spaces.filter((space) => space.role === 'write' || space.role === 'manage')
  return (
    writable.find((space) => space.name === open) ??
    writable.find((space) => space.name === chosen) ??
    writable.find((space) => space.role === 'manage') ??
    writable[0] ??
    null
  )
}

/** The space of what the page shows (`/note/Garden/Plan.md` gives Garden), or null. */
export function openSpaceOf(pathname: string): string | null {
  const match = /^\/(?:note|file|folder)\/([^/]+)/.exec(pathname)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

const WIKI = /\[\[([^\]|#]*)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g

/** A task's text in pieces, its wiki links as the words they show (`[[Note|shown]]` shows "shown"), as Obsidian does. */
export function taskParts(text: string): { text: string; link: boolean }[] {
  const parts: { text: string; link: boolean }[] = []
  let position = 0
  for (const match of text.matchAll(WIKI)) {
    if (match.index > position) parts.push({ text: text.slice(position, match.index), link: false })
    const shown = (match[3] ?? '').trim() || (match[1] + (match[2] ?? '')).trim()
    parts.push({ text: shown || match[0], link: true })
    position = match.index + match[0].length
  }
  if (position < text.length) parts.push({ text: text.slice(position), link: false })
  return parts
}

/** A task's text as one line of words, its wiki links as they show (the calendar, where there is no room for more). */
export function taskPlain(text: string): string {
  return taskParts(text).map((part) => part.text).join('')
}

/**
 * Now, as this device has it, with its offset (`2026-10-01T06:50:00+13:00`): templates and daily notes take their
 * `{{time}}` from it, not from the server's clock (review before 1.0.0, P5.1).
 */
export function readerNow(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const offset = -now.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  return `${local}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
}

/** The time on this device's clock, `14:05`. */
export function clockTime(now = new Date()): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

const WEEKDAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const SHORT_DAYS: Record<string, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 }

/**
 * A repetition as the Tasks plugin writes it (`every 2 weeks on Monday`), said in the interface's words; one it
 * does not know stays as written. The file keeps the plugin's English.
 */
export function recurrenceWords(rule: string, t: (key: string, values?: Record<string, unknown>) => string, language: string): string {
  const clean = rule.trim().toLowerCase().replace(/\s+/g, ' ')
  const done = clean.endsWith(' when done')
  const core = done ? clean.slice(0, -' when done'.length) : clean
  const tail = done ? ' ' + t('recur.whenDone') : ''
  if (core === 'every weekday') return t('recur.weekday') + tail
  const match = /^every(?: (\d{1,4}))? (day|week|month|year)s?(?: on (.+))?$/.exec(core)
  if (!match) return rule
  const count = Number(match[1] ?? 1)
  let words = t(`recur.${match[2]}`, { count })
  if (match[3]) {
    const days = match[3].split(/\s*(?:,|and)\s*/).map((day) => {
      const index = WEEKDAY_NAMES.indexOf(day) >= 0 ? WEEKDAY_NAMES.indexOf(day) : SHORT_DAYS[day]
      // 5 October 2026 is a Monday.
      return index === undefined ? day : new Date(2026, 9, 5 + index).toLocaleDateString(language, { weekday: 'long' })
    })
    words += ' ' + t('recur.on', { days: new Intl.ListFormat(language, { type: 'conjunction' }).format(days) })
  }
  return words + tail
}
