/**
 * The task overview (M6): every task of every space the account may read, in the Obsidian Tasks format. Chips for
 * open, overdue, today, this week, later, no date and done, with their counts; a space, a tag, words. Open tasks are
 * grouped by when they are due (or by note, switchable, remembered per browser). Ticking one off writes that one line.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { ApiError, everydayApi, type TaskCounts, type TaskItem, type TaskQuery, type TaskWhen, type Toggled } from '../api/client'
import { Symbol } from '../components/Symbol'
import { TaskRow } from '../components/TaskRow'
import { errorText } from '../lib/errors'
import { today as todayIso, whenOf } from '../lib/everyday'
import { noteUrl } from '../lib/vault'
import { useStore } from '../state/store'

type Chip = 'open' | TaskWhen | 'done'
const CHIPS: Chip[] = ['open', 'overdue', 'today', 'week', 'later', 'none', 'done']
const GROUPS: TaskWhen[] = ['overdue', 'today', 'week', 'later', 'none']
const PAGE = 200
const GROUP_KEY = 'nexlore.tasks.group'

function storedGroup(): 'due' | 'note' {
  try {
    return localStorage.getItem(GROUP_KEY) === 'note' ? 'note' : 'due'
  } catch {
    return 'due'
  }
}

export function TasksPage() {
  const { t } = useTranslation()
  const { spaces } = useStore()
  const [chip, setChip] = useState<Chip>('open')
  const [space, setSpace] = useState('')
  const [tag, setTag] = useState('')
  const [words, setWords] = useState('')
  const [query, setQuery] = useState({ tag: '', q: '' })
  const [group, setGroup] = useState<'due' | 'note'>(storedGroup)
  const [items, setItems] = useState<TaskItem[]>([])
  const [counts, setCounts] = useState<TaskCounts | null>(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const today = todayIso()
  // Only the newest answer counts: chips clicked through fast must not show an older filter's tasks.
  const asked = useRef(0)

  // Typing waits a moment before it asks the server.
  useEffect(() => {
    const timer = setTimeout(() => setQuery({ tag: tag.trim(), q: words.trim() }), 300)
    return () => clearTimeout(timer)
  }, [tag, words])

  const ask = useCallback(
    (offset: number, limit = PAGE): TaskQuery => ({
      today,
      status: chip === 'done' ? 'done' : 'open',
      when: chip === 'open' || chip === 'done' ? undefined : chip,
      space: space || undefined,
      tag: query.tag || undefined,
      q: query.q || undefined,
      offset,
      limit,
    }),
    [chip, space, query, today],
  )

  const load = useCallback(
    async (keep = 0) => {
      const mine = ++asked.current
      setLoading(true)
      try {
        const answer = await everydayApi.tasks(ask(0, Math.max(PAGE, keep)))
        if (mine !== asked.current) return
        setItems(answer.items)
        setCounts(answer.counts)
        setTotal(answer.total)
        setProblem(null)
      } catch (error) {
        if (mine === asked.current) setProblem(error instanceof ApiError ? error.code : 'internal_error')
      } finally {
        if (mine === asked.current) setLoading(false)
      }
    },
    [ask],
  )

  useEffect(() => {
    void load()
  }, [load])

  const more = async () => {
    const mine = asked.current
    const answer = await everydayApi.tasks(ask(items.length))
    if (mine === asked.current) setItems((current) => [...current, ...answer.items])
  }

  const toggled = (_task: TaskItem, result: Toggled) => {
    setNotice(result.conflict ? t('tasks.conflict') : result.added ? t('tasks.repeated') : null)
    // The counts change, and a ticked task leaves "open": the list is loaded again, as long as it was.
    void load(items.length)
  }

  const problemWhileTicking = (code: string) => {
    setNotice(code === 'task_changed' ? t('tasks.changed') : errorText(code))
    if (code === 'task_changed') void load(items.length)
  }

  const chooseGroup = (value: 'due' | 'note') => {
    setGroup(value)
    try {
      localStorage.setItem(GROUP_KEY, value)
    } catch {
      // Remembered for this visit only.
    }
  }

  const blocks = useMemo(() => {
    if (chip === 'done') return [{ key: 'done', label: '', items }]
    if (group === 'note') {
      const byNote = new Map<string, TaskItem[]>()
      for (const item of items) byNote.set(item.path, [...(byNote.get(item.path) ?? []), item])
      return [...byNote.entries()].map(([path, list]) => ({ key: path, label: path, items: list }))
    }
    return GROUPS.map((when) => ({ key: when, label: when, items: items.filter((item) => whenOf(item, today) === when) })).filter(
      (block) => block.items.length > 0,
    )
  }, [chip, group, items, today])

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="tasks-page">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-700 px-3 py-3 sm:px-4">
        <h1 className="mr-2 text-lg font-semibold text-mist-100">{t('tasks.title')}</h1>
        <div className="-mx-1 flex max-w-full gap-1.5 overflow-x-auto px-1 pb-0.5" role="group" aria-label={t('tasks.title')}>
          {CHIPS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setChip(key)}
              aria-pressed={chip === key}
              className={
                'shrink-0 rounded-full border px-3 py-1 text-xs whitespace-nowrap ' +
                (chip === key ? 'border-accent-500/50 bg-accent-500/15 text-accent-400' : 'border-ink-700 text-mist-400 hover:bg-ink-850') +
                (key === 'overdue' && counts && counts.overdue > 0 && chip !== key ? ' text-bad-500' : '')
              }
            >
              {t(`tasks.filter.${key}`)}
              {counts && <span className="ml-1 tabular-nums opacity-80">{counts[key]}</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-2 border-b border-ink-700 px-3 py-2 sm:px-4">
        <label className="min-w-0 flex-1 basis-40 text-xs text-mist-500">
          <span className="sr-only">{t('tasks.search')}</span>
          <input
            type="search"
            value={words}
            onChange={(event) => setWords(event.target.value)}
            placeholder={t('tasks.search')}
            className="h-8 w-full rounded-lg border border-ink-700 bg-ink-850 px-2.5 text-sm text-mist-100 outline-none focus:border-accent-500"
          />
        </label>
        <label className="w-28 text-xs text-mist-500">
          <span className="sr-only">{t('tasks.tag')}</span>
          <input
            value={tag}
            onChange={(event) => setTag(event.target.value)}
            placeholder={'#' + t('tasks.tag').toLowerCase()}
            className="h-8 w-full rounded-lg border border-ink-700 bg-ink-850 px-2.5 text-sm text-mist-100 outline-none focus:border-accent-500"
          />
        </label>
        <label className="text-xs text-mist-500">
          <span className="sr-only">{t('tasks.space')}</span>
          <select
            value={space}
            onChange={(event) => setSpace(event.target.value)}
            aria-label={t('tasks.space')}
            className="h-8 max-w-40 rounded-lg border border-ink-700 bg-ink-850 px-2 text-sm text-mist-200"
          >
            <option value="">{t('tasks.allSpaces')}</option>
            {spaces.map((item) => (
              <option key={item.id} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {chip !== 'done' && (
          <div className="flex rounded-full border border-ink-700 p-0.5 text-xs" role="group" aria-label={t('tasks.groupBy')}>
            {(['due', 'note'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={group === value}
                onClick={() => chooseGroup(value)}
                className={'rounded-full px-2.5 py-1 ' + (group === value ? 'bg-accent-500/15 text-accent-400' : 'text-mist-400')}
              >
                {t(value === 'due' ? 'tasks.byDue' : 'tasks.byNote')}
              </button>
            ))}
          </div>
        )}
      </div>
      {notice && (
        <div className="flex items-start gap-2 border-b border-warn-500/30 bg-warn-500/10 px-4 py-2 text-sm text-warn-500" role="status">
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label={t('common.close')} className="rounded p-0.5">
            <Symbol name="close" className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-3 sm:px-3">
        {problem && <p className="px-3 text-sm text-bad-500">{errorText(problem)}</p>}
        {!problem && !loading && items.length === 0 && <p className="px-3 text-sm text-mist-500">{t('tasks.empty')}</p>}
        {blocks.map((block) => (
          <section key={block.key} className="mb-4">
            {block.label && group === 'note' && chip !== 'done' ? (
              <h2 className="flex min-w-0 items-center gap-2 px-3 pb-1 text-sm font-medium text-mist-300">
                <Symbol name="note" className="h-3.5 w-3.5 shrink-0 text-mist-500" />
                <Link to={noteUrl(block.label)} className="truncate hover:text-accent-400">
                  {block.label.slice(0, -3)}
                </Link>
              </h2>
            ) : block.label ? (
              <h2
                className={
                  'px-3 pb-1 text-xs font-semibold tracking-wide uppercase ' + (block.label === 'overdue' ? 'text-bad-500' : 'text-mist-500')
                }
              >
                {t(`tasks.filter.${block.label}`)} <span className="font-normal text-mist-600">{block.items.length}</span>
              </h2>
            ) : null}
            <ul>
              {block.items.map((task) => (
                <TaskRow
                  key={`${task.id}:${task.raw}`}
                  task={task}
                  today={today}
                  showNote={group !== 'note' || chip === 'done'}
                  onToggled={toggled}
                  onProblem={problemWhileTicking}
                />
              ))}
            </ul>
          </section>
        ))}
        {items.length < total && (
          <div className="px-3">
            <button type="button" onClick={() => void more()} className="rounded-full border border-ink-700 px-3 py-1 text-sm text-mist-300 hover:bg-ink-850">
              {t('tasks.more')} <span className="text-mist-600">({items.length} / {total})</span>
            </button>
          </div>
        )}
        <p className="px-3 pt-2 text-xs text-mist-600">{t('tasks.hint')}</p>
      </div>
    </main>
  )
}
