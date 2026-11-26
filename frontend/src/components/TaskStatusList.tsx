/**
 * What the characters between a task's brackets mean in a space (Issue #14), inside the space's options: what the
 * Tasks plugin's settings in the space say (read only, they live in Obsidian), and the managers' own list, which
 * stands above them. A row is a character, a name and what it counts as.
 */
import { useTranslation } from 'react-i18next'

import type { TaskKind, TaskStatusEntry, TaskStatuses } from '../api/client'
import { Button } from './settings/ui'
import { Symbol } from './Symbol'

const TASK_KINDS: TaskKind[] = ['todo', 'in_progress', 'on_hold', 'done', 'cancelled', 'non_task']

export type OwnStatus = Pick<TaskStatusEntry, 'mark' | 'kind' | 'name'>

/** The last character typed: the field holds one, and typing another replaces it. */
function lastCharacter(value: string): string {
  const characters = Array.from(value)
  return characters[characters.length - 1] ?? ''
}

export function TaskStatusList({
  statuses,
  own,
  onChange,
}: {
  statuses: TaskStatuses
  own: OwnStatus[]
  onChange: (own: OwnStatus[]) => void
}) {
  const { t } = useTranslation()
  const kindLabel = (kind: TaskKind) => t(`tasks.kind.${kind}`)
  const marks = own.map((row) => row.mark).filter(Boolean)
  const twice = new Set(marks).size !== marks.length
  const change = (index: number, row: Partial<OwnStatus>) => onChange(own.map((entry, at) => (at === index ? { ...entry, ...row } : entry)))

  return (
    <section className="grid gap-2 rounded-xl border border-ink-700 p-3" aria-labelledby="task-statuses-title" data-testid="task-statuses">
      <h3 id="task-statuses-title" className="text-sm font-medium text-mist-200">
        {t('spaceOptions.statuses')}
      </h3>
      <p className="text-xs text-mist-500">{t('spaceOptions.statusesText')}</p>
      {statuses.plugin && statuses.plugin.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-xs text-mist-400">{t('spaceOptions.statusesPlugin')}</p>
          <ul className="flex flex-wrap gap-1.5" data-testid="task-statuses-plugin">
            {statuses.plugin.map((entry) => (
              <li key={entry.mark} className="rounded-full border border-ink-700 bg-ink-850 px-2 py-0.5 text-xs text-mist-300">
                <code className="text-warn-500">[{entry.mark}]</code> {entry.name || kindLabel(entry.kind)}
                <span className="text-mist-500"> · {kindLabel(entry.kind)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {statuses.plugin_unreadable && <p className="text-xs text-warn-500">{t('spaceOptions.statusesPluginUnreadable')}</p>}
      <p className="text-xs text-mist-400">{t('spaceOptions.statusesOwn')}</p>
      {own.length === 0 && <p className="text-xs text-mist-500">{t('spaceOptions.statusesNone')}</p>}
      {own.map((row, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2" data-testid="task-status-row">
          <input
            value={row.mark}
            onChange={(event) => change(index, { mark: lastCharacter(event.target.value) })}
            aria-label={t('spaceOptions.statusMark')}
            placeholder="r"
            className="h-9 w-12 rounded-lg border border-ink-700 bg-ink-850 text-center font-mono text-sm outline-none focus:border-accent-500"
          />
          <input
            value={row.name}
            maxLength={60}
            onChange={(event) => change(index, { name: event.target.value })}
            aria-label={t('spaceOptions.statusName')}
            placeholder={t('spaceOptions.statusName')}
            className="h-9 min-w-0 flex-1 basis-32 rounded-lg border border-ink-700 bg-ink-850 px-2.5 text-sm outline-none focus:border-accent-500"
          />
          <select
            value={row.kind}
            onChange={(event) => change(index, { kind: event.target.value as TaskKind })}
            aria-label={t('spaceOptions.statusKind')}
            className="h-9 rounded-lg border border-ink-700 bg-ink-850 px-2 text-sm"
          >
            {TASK_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kindLabel(kind)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => onChange(own.filter((_entry, at) => at !== index))}
            aria-label={t('spaceOptions.statusRemove', { mark: row.mark ? `[${row.mark}]` : '' })}
            className="rounded-full p-1.5 text-mist-500 hover:bg-ink-850 hover:text-bad-500"
          >
            <Symbol name="close" className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      {twice && <p className="text-xs text-bad-500">{t('spaceOptions.statusTwice')}</p>}
      <div>
        <Button onClick={() => onChange([...own, { mark: '', kind: 'todo', name: '' }])}>{t('spaceOptions.statusAdd')}</Button>
      </div>
    </section>
  )
}
