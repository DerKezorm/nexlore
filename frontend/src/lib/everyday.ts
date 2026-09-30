/**
 * Dates and groups for everyday use (M6): the calendar's month, a task's group in the overview, the space daily
 * notes go to. Dates travel as `JJJJ-MM-TT` in the browser's own time: "today" is the reader's today, not the server's.
 */
import type { Space, TaskItem, TaskWhen } from '../api/client'
import { ownKey } from './accountStorage'

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
export function monthGrid(month: string): (string | null)[][] {
  const first = atNoon(month + '-01')
  const lead = (first.getDay() + 6) % 7
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

const DAILY_SPACE_KEY = 'nexlore.daily.space'

/** The space "Today" opens the daily note in: the one chosen last, else the first one the account may write in. */
export function dailySpace(spaces: Space[]): Space | null {
  const writable = spaces.filter((space) => space.role === 'write' || space.role === 'manage')
  let chosen: string | null = null
  try {
    chosen = localStorage.getItem(ownKey(DAILY_SPACE_KEY))
  } catch {
    // Storage blocked: the first one then.
  }
  return writable.find((space) => space.name === chosen) ?? writable[0] ?? null
}

export function rememberDailySpace(name: string): void {
  try {
    localStorage.setItem(ownKey(DAILY_SPACE_KEY), name)
  } catch {
    // Not kept, nothing lost.
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
