/**
 * One task of the overview or the calendar: the checkbox, the text with its tags, its dates, the note it stands in.
 * Ticking it off asks the server to change that one line (`/api/tasks/toggle`); the box shows the new state at once
 * and goes back if the server says no.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { ApiError, everydayApi, type TaskItem, type Toggled } from '../api/client'
import { atNoon, dayOf, PRIORITY_MARK, recurrenceWords, taskParts } from '../lib/everyday'
import { noteUrl } from '../lib/vault'
import { Symbol } from './Symbol'

/** A task as a name for its box: its words without the dates and marks, short. */
function taskName(task: TaskItem): string {
  const words = taskParts(task.text)
    .map((part) => part.text)
    .join('')
    .replace(/[\u{1F4C5}\u{1F4C6}\u{1F5D3}\u{23F3}\u{1F6EB}\u{2705}\u{2795}\u{274C}\u{1F501}\u{23EB}\u{1F53C}\u{1F53D}\u{1F53A}\u{23EC}]\u{FE0F}?\s*(\d{4}-\d{2}-\d{2})?/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  return words.length > 80 ? words.slice(0, 79) + '…' : words || task.path
}

export function TaskRow({
  task,
  today,
  showNote = true,
  readOnly = false,
  onToggled,
  onProblem,
}: {
  task: TaskItem
  today: string
  showNote?: boolean
  /** The task's space is only for reading: the box shows its state and cannot be ticked (it gave a 403, P5.21). */
  readOnly?: boolean
  onToggled: (task: TaskItem, result: Toggled) => void
  onProblem: (code: string) => void
}) {
  const { t, i18n } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState<boolean | null>(null)
  const done = shown ?? task.status !== 'open'
  const day = dayOf(task)
  const late = !done && task.due !== null && task.due < today

  const tick = async () => {
    if (busy) return
    setBusy(true)
    setShown(!done)
    try {
      const result = await everydayApi.toggle(task, !done, today)
      onToggled(task, result)
    } catch (error) {
      setShown(null)
      onProblem(error instanceof ApiError ? error.code : 'internal_error')
    } finally {
      setBusy(false)
    }
  }

  const nice = (iso: string) =>
    iso === today ? t('tasks.today') : atNoon(iso).toLocaleDateString(i18n.language, { weekday: 'short', day: 'numeric', month: 'short' })

  return (
    <li className="group flex items-start gap-3 rounded-xl px-2 py-2 hover:bg-ink-850 sm:px-3" data-testid="task-row">
      <button
        type="button"
        onClick={() => void tick()}
        disabled={busy || readOnly}
        aria-pressed={done}
        aria-label={readOnly ? t('tasks.readOnly') : `${done ? t('tasks.untick') : t('tasks.tick')}: ${taskName(task)}`}
        title={readOnly ? t('tasks.readOnly') : done ? t('tasks.untick') : t('tasks.tick')}
        className={
          'nn-touch-self mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md border sm:h-5 sm:w-5 ' +
          (readOnly ? 'cursor-not-allowed opacity-50 ' : '') +
          (done ? 'border-accent-500 bg-accent-500 text-on-accent' : 'border-edge' + (readOnly ? '' : ' hover:border-accent-500'))
        }
      >
        {done && <Symbol name="check" className="h-3.5 w-3.5" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className={'text-sm break-words ' + (done ? 'text-mist-600 line-through' : 'text-mist-100')}>
          {PRIORITY_MARK[task.priority] && (
            <span className="mr-1" title={t(`tasks.priority.${task.priority}`)} aria-label={t(`tasks.priority.${task.priority}`)}>
              {PRIORITY_MARK[task.priority]}
            </span>
          )}
          {task.text
            ? taskParts(task.text).map((part, index) =>
                part.link ? (
                  <span key={index} className={done ? '' : 'text-accent-400'}>
                    {part.text}
                  </span>
                ) : (
                  part.text
                ),
              )
            : '…'}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
          {day && (
            <span className={late ? 'text-bad-500' : day === today ? 'text-accent-400' : 'text-mist-500'}>
              {task.due ? '📅' : '⏳'} {nice(day)}
            </span>
          )}
          {!done && task.mark === '/' && (
            <span className="rounded-full bg-warn-500/15 px-1.5 text-warn-500" data-testid="in-progress">
              {t('tasks.inProgress')}
            </span>
          )}
          {task.recurrence && <span className="text-mist-500" title={task.recurrence}>🔁 {recurrenceWords(task.recurrence, t, i18n.language)}</span>}
          {done && task.completed && <span className="text-mist-600">✅ {nice(task.completed)}</span>}
          {showNote && (
            <Link to={noteUrl(task.path)} className="min-w-0 truncate text-mist-500 hover:text-accent-400" title={task.path}>
              {task.path.slice(0, -3)}
            </Link>
          )}
        </div>
      </div>
    </li>
  )
}

