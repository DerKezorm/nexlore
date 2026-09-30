/**
 * The calendar (M6): a month, Monday first, with the daily notes and the tasks due on each day, over every space the
 * account may read or one of them. A click on a day opens its daily note, or makes it from the space's template.
 * Next to it (below on a phone) the open tasks of the month, day by day, to tick off.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { ApiError, everydayApi, type CalendarDay, type TaskItem } from '../api/client'
import { Symbol } from '../components/Symbol'
import { TaskRow } from '../components/TaskRow'
import { errorText } from '../lib/errors'
import { atNoon, dayOf, homeSpace, lastDay, monthGrid, monthOf, shiftMonth, taskPlain, today as todayIso } from '../lib/everyday'
import { useAuth } from '../state/auth'
import { noteUrl } from '../lib/vault'
import { useStore } from '../state/store'

const MONTH = /^\d{4}-\d{2}$/

export function CalendarPage() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { spaces } = useStore()
  const { me, setAppearance } = useAuth()
  const readOnlyIn = useMemo(() => new Set(spaces.filter((item) => item.role === 'read').map((item) => item.name)), [spaces])
  const [params, setParams] = useSearchParams()
  const today = todayIso()
  const month = MONTH.test(params.get('month') ?? '') ? params.get('month')! : monthOf(today)
  const space = params.get('space') ?? ''
  const [days, setDays] = useState<Record<string, CalendarDay>>({})
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Only the newest answer counts: months clicked through fast must not show an older month's numbers.
  const asked = useRef(0)

  const writable = spaces.filter((item) => item.role === 'write' || item.role === 'manage')
  // Where a new daily note goes: the chosen space, or with all spaces shown the one picked below the calendar.
  const home = space || target || homeSpace(spaces, me?.appearance?.home_space)?.name || ''

  const load = useCallback(async () => {
    const mine = ++asked.current
    setLoading(true)
    try {
      const [calendar, due] = await Promise.all([
        everydayApi.calendar(month, today, space || undefined),
        everydayApi.tasks({ today, status: 'open', start: `${month}-01`, end: lastDay(month), space: space || undefined, limit: 500 }),
      ])
      if (mine !== asked.current) return
      setDays(calendar.days)
      setTasks(due.items)
      setProblem(null)
    } catch (error) {
      if (mine === asked.current) setProblem(error instanceof ApiError ? error.code : 'internal_error')
    } finally {
      if (mine === asked.current) setLoading(false)
    }
  }, [month, space, today])

  useEffect(() => {
    void load()
  }, [load])

  const go = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    setParams(next, { replace: true })
  }

  const open = async (date: string) => {
    const existing = days[date]?.daily.find((path) => !space || path.startsWith(space + '/'))
    const inHome = days[date]?.daily.find((path) => path.startsWith(home + '/'))
    const found = inHome ?? existing
    if (found) {
      navigate(noteUrl(found))
      return
    }
    if (!home) {
      setNotice(t('today.none'))
      return
    }
    const role = spaces.find((item) => item.name === home)?.role
    if (role === 'read') {
      setNotice(t('calendar.readOnly'))
      return
    }
    setOpening(date)
    try {
      const made = await everydayApi.daily(home, date)
      navigate(noteUrl(made.path) + (made.created ? '?edit=1' : ''), { state: made.template_missing ? { templateMissing: true } : undefined })
    } catch (error) {
      setNotice(errorText(error instanceof ApiError ? error.code : 'internal_error'))
    } finally {
      setOpening(null)
    }
  }

  const byDay = useMemo(() => {
    const grouped = new Map<string, TaskItem[]>()
    for (const task of tasks) {
      const day = dayOf(task)
      if (day) grouped.set(day, [...(grouped.get(day) ?? []), task])
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [tasks])

  const weekStart = me?.appearance?.week_start ?? 'monday'
  const weekdays = useMemo(() => {
    // 27 September 2026 is a Sunday, the 28th a Monday.
    const first = atNoon(weekStart === 'sunday' ? '2026-09-27' : '2026-09-28')
    return Array.from({ length: 7 }, (_, index) => {
      const day = new Date(first)
      day.setDate(first.getDate() + index)
      return day.toLocaleDateString(i18n.language, { weekday: 'short' })
    })
  }, [i18n.language, weekStart])
  // Month and year to jump to: a year back is no longer twelve clicks (P5.24).
  const monthNames = useMemo(
    () => Array.from({ length: 12 }, (_, index) => atNoon(`2026-${String(index + 1).padStart(2, '0')}-01`).toLocaleDateString(i18n.language, { month: 'long' })),
    [i18n.language],
  )
  const shownYear = Number(month.slice(0, 4))
  const years = Array.from({ length: 61 }, (_, index) => Number(today.slice(0, 4)) - 50 + index)
  if (!years.includes(shownYear)) years.push(shownYear)

  const title = atNoon(month + '-01').toLocaleDateString(i18n.language, { month: 'long', year: 'numeric' })
  const weekdayName = (iso: string) => atNoon(iso).toLocaleDateString(i18n.language, { weekday: 'long' })
  const long = (iso: string) => atNoon(iso).toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden" data-testid="calendar-page">
      <section className="min-w-0 flex-1 px-3 py-3 sm:px-4 sm:py-4 lg:overflow-y-auto">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => go({ month: shiftMonth(month, -1) })} aria-label={t('calendar.previous')} className="grid h-8 w-8 place-items-center rounded-full text-mist-400 hover:bg-ink-850">
            <Symbol name="chevronLeft" />
          </button>
          <h1 className="sr-only" aria-live="polite">
            {title}
          </h1>
          <select
            value={month.slice(5, 7)}
            onChange={(event) => go({ month: `${month.slice(0, 4)}-${event.target.value}` })}
            aria-label={t('calendar.pickMonth')}
            className="h-8 rounded-full border border-transparent bg-transparent px-1 text-lg font-semibold text-mist-100 capitalize hover:border-ink-700"
          >
            {monthNames.map((name, index) => (
              <option key={name} value={String(index + 1).padStart(2, '0')}>
                {name}
              </option>
            ))}
          </select>
          <select
            value={shownYear}
            onChange={(event) => go({ month: `${event.target.value}-${month.slice(5, 7)}` })}
            aria-label={t('calendar.pickYear')}
            className="h-8 rounded-full border border-transparent bg-transparent px-1 text-lg font-semibold text-mist-100 tabular-nums hover:border-ink-700"
          >
            {years.sort((a, b) => a - b).map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => go({ month: shiftMonth(month, 1) })} aria-label={t('calendar.next')} className="grid h-8 w-8 place-items-center rounded-full text-mist-400 hover:bg-ink-850">
            <Symbol name="chevronRight" />
          </button>
          <button type="button" onClick={() => go({ month: '' })} className="rounded-full border border-ink-700 px-3 py-1 text-xs text-mist-300 hover:bg-ink-850">
            {t('calendar.today')}
          </button>
          <select
            value={space}
            onChange={(event) => go({ space: event.target.value })}
            aria-label={t('calendar.space')}
            className="ml-auto h-8 max-w-40 rounded-full border border-ink-700 bg-ink-850 px-2 text-xs text-mist-300"
          >
            <option value="">{t('calendar.allSpaces')}</option>
            {spaces.map((item) => (
              <option key={item.id} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        {problem && <p className="mb-2 text-sm text-bad-500">{errorText(problem)}</p>}
        <div
          className={'grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-ink-700 bg-ink-700 text-xs transition-opacity ' + (loading ? 'opacity-60' : '')}
          aria-busy={loading}
        >
          {weekdays.map((name) => (
            <div key={name} aria-hidden="true" className="bg-ink-900 px-1 py-1.5 text-center text-mist-500">
              {name}
            </div>
          ))}
          {monthGrid(month, weekStart).flat().map((date, index) => {
            if (!date) return <div key={`empty-${index}`} className="bg-ink-950" />
            const info = days[date]
            const due = tasks.filter((task) => dayOf(task) === date)
            const late = (info?.overdue ?? 0) > 0
            const daily = (info?.daily.length ?? 0) > 0
            return (
              <button
                key={date}
                type="button"
                onClick={() => void open(date)}
                disabled={opening === date}
                aria-label={t('calendar.dayLabel', { date: long(date) })}
                data-date={date}
                className="flex h-14 min-w-0 flex-col items-start gap-1 bg-ink-900 p-1 text-left hover:bg-ink-850 focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:outline-none focus-visible:ring-inset sm:h-24 sm:p-1.5"
              >
                <span className={'grid h-6 w-6 shrink-0 place-items-center rounded-full ' + (date === today ? 'bg-accent-500 font-semibold text-on-accent' : 'text-mist-300')}>
                  {Number(date.slice(8))}
                </span>
                <span className="flex gap-0.5 pl-1 sm:hidden" aria-hidden="true">
                  {daily && <span className="h-1.5 w-1.5 rounded-full bg-accent-500" />}
                  {(info?.open ?? 0) > 0 && <span className={'h-1.5 w-1.5 rounded-full ' + (late ? 'bg-bad-500' : 'bg-warn-500')} />}
                </span>
                <span className="hidden w-full min-w-0 flex-col gap-0.5 sm:flex">
                  {daily && (
                    <span className="flex items-center gap-1 truncate text-accent-400">
                      <Symbol name="note" className="h-3 w-3 shrink-0" />
                      {t('calendar.dailyNote')}
                    </span>
                  )}
                  {due.slice(0, daily ? 1 : 2).map((task) => (
                    <span key={task.id} className={'block w-full truncate ' + (late ? 'text-bad-500' : 'text-mist-300')}>
                      {taskPlain(task.text)}
                    </span>
                  ))}
                  {(info?.open ?? 0) > (daily ? 1 : 2) && (
                    <span className="text-mist-500">+{(info?.open ?? 0) - (daily ? 1 : 2)}</span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          <p className="text-xs text-mist-600">{t('calendar.hint')}</p>
          <Link to="/account#calendar" className="text-xs text-accent-400 hover:underline">
            {t('calendar.subscribe')}
          </Link>
          <label className="ml-auto flex items-center gap-2 text-xs text-mist-500">
            {t('calendar.weekStart')}
            <select
              value={weekStart}
              onChange={(event) => void setAppearance({ week_start: event.target.value as 'monday' | 'sunday' })}
              className="h-7 rounded-full border border-ink-700 bg-ink-850 px-2 text-xs text-mist-300"
            >
              <option value="monday">{weekdayName('2026-09-28')}</option>
              <option value="sunday">{weekdayName('2026-09-27')}</option>
            </select>
          </label>
        </div>
        {!space && writable.length > 1 && (
          <label className="mt-2 flex flex-wrap items-center gap-2 text-xs text-mist-500">
            {t('calendar.into')}
            <select
              value={home}
              onChange={(event) => setTarget(event.target.value)}
              className="h-7 rounded-full border border-ink-700 bg-ink-850 px-2 text-xs text-mist-300"
            >
              {writable.map((item) => (
                <option key={item.id} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {notice && (
          <p className="mt-2 text-sm text-warn-500" role="status">
            {notice}
          </p>
        )}
      </section>
      <aside className="w-full shrink-0 border-t border-ink-700 px-2 py-3 sm:px-3 lg:w-96 lg:overflow-y-auto lg:border-t-0 lg:border-l">
        <h2 className="px-2 text-sm font-semibold text-mist-100">{t('calendar.month')}</h2>
        {byDay.length === 0 && <p className="px-2 pt-2 text-sm text-mist-500">{t('calendar.nothing')}</p>}
        {byDay.map(([day, list]) => (
          <section key={day} className="mt-3">
            <h3 className={'px-2 text-xs font-semibold ' + (day < today ? 'text-bad-500' : day === today ? 'text-accent-400' : 'text-mist-500')}>
              {long(day)}
            </h3>
            <ul>
              {list.map((task) => (
                <TaskRow
                  key={`${task.id}:${task.raw}`}
                  task={task}
                  today={today}
                  readOnly={readOnlyIn.has(task.path.split('/')[0])}
                  onToggled={(_task, result) => {
                    setNotice(result.conflict ? t('tasks.conflict') : result.added ? t('tasks.repeated') : null)
                    void load()
                  }}
                  onProblem={(code) => {
                    setNotice(code === 'task_changed' ? t('tasks.changed') : errorText(code))
                    void load()
                  }}
                />
              ))}
            </ul>
          </section>
        ))}
      </aside>
    </main>
  )
}
