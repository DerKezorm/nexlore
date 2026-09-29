/**
 * A view over notes, as Obsidian's Bases (`routers/bases.py`): a table, cards, a list or a board of the notes the
 * view's filters let through, with its formulas. A cell of a property changes that property in the note (for who
 * may write); on a board a card dragged to another column takes that column's value. A `.base` file's YAML can be
 * edited right here.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { ApiError, basesApi, type BaseAnswer, type BaseRow } from '../api/client'
import { folderColor } from '../graph/palette'
import { errorText } from '../lib/errors'
import { formatDay } from '../lib/markdown'
import { noteUrl } from '../lib/vault'
import { Symbol } from './Symbol'

export type BaseSource = { kind: 'file'; path: string } | { kind: 'block'; note: string; text: string }

function shown(value: unknown, key: string): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? '✓' : '✗'
  if (Array.isArray(value)) return value.map((item) => shown(item, key)).join(', ')
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && (key.endsWith('time') || /^\d{4}-\d{2}-\d{2}(T|$)/.test(value))) return formatDay(value)
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/** What the person typed, in the kind of value the cell held. */
function typed(text: string, before: unknown): unknown {
  if (Array.isArray(before)) return text.split(',').map((item) => item.trim()).filter(Boolean)
  if (typeof before === 'number' && text.trim() !== '' && !Number.isNaN(Number(text.replace(',', '.')))) return Number(text.replace(',', '.'))
  if (text.trim() === '') return null
  return text
}

export function BaseView({ source }: { source: BaseSource }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [view, setView] = useState(0)
  const [answer, setAnswer] = useState<BaseAnswer | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ path: string; key: string; text: string } | null>(null)
  const [yaml, setYaml] = useState<string | null>(null)
  const [dragged, setDragged] = useState<BaseRow | null>(null)

  // By what it says, not by the object: a page that draws anew hands in a new object with the same view.
  const kind = source.kind
  const where = source.kind === 'file' ? source.path : source.note
  const text = source.kind === 'block' ? source.text : ''
  const load = useCallback(async () => {
    try {
      const found = kind === 'file' ? await basesApi.view(where, view) : await basesApi.block(where, text, view)
      setAnswer(found)
      setProblem(null)
    } catch (error) {
      setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
    }
  }, [kind, where, text, view])
  useEffect(() => {
    void load()
  }, [load])

  const write = async (path: string, key: string, value: unknown) => {
    try {
      await basesApi.cell(path, key, value)
      await load()
    } catch (error) {
      setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
    }
  }
  const saveYaml = async () => {
    if (yaml === null || !answer?.hash || source.kind !== 'file') return
    try {
      await basesApi.save(source.path, yaml, answer.hash)
      setYaml(null)
      await load()
    } catch (error) {
      setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
    }
  }

  if (!answer) return <div className="text-sm text-mist-500" data-testid="base-view">{problem ?? t('common.loading')}</div>
  const writable = (key: string) => key.startsWith('note.')
  const cell = (row: BaseRow, key: string) => {
    const value = row.cells[key]
    if (editing && editing.path === row.path && editing.key === key) {
      return (
        <input
          autoFocus
          value={editing.text}
          onChange={(event) => setEditing({ ...editing, text: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setEditing(null)
            if (event.key === 'Enter') {
              setEditing(null)
              void write(row.path, key, typed(editing.text, value))
            }
          }}
          onBlur={() => setEditing(null)}
          aria-label={t('bases.cell', { key })}
          className="w-full rounded border border-accent-500 bg-ink-950 px-1.5 py-0.5 text-sm"
        />
      )
    }
    if (typeof value === 'boolean' && writable(key)) {
      return <input type="checkbox" checked={value} onChange={() => void write(row.path, key, !value)} aria-label={t('bases.cell', { key })} className="accent-accent-500" />
    }
    return (
      <span
        className={writable(key) ? 'block min-h-5 cursor-text rounded px-1 hover:outline hover:outline-1 hover:outline-ink-600' : 'block px-1'}
        onClick={() => writable(key) && setEditing({ path: row.path, key, text: Array.isArray(value) ? value.join(', ') : value === null || value === undefined ? '' : String(value) })}
      >
        {shown(value, key)}
      </span>
    )
  }
  const title = (row: BaseRow) => (
    <button type="button" onClick={() => navigate(noteUrl(row.path))} data-note={row.path} className="text-left font-medium text-accent-300 hover:underline">
      {row.title}
    </button>
  )
  const rest = answer.columns.filter((column) => column.key !== 'file.name')
  const all = answer.groups.flatMap((group) => group.rows)

  return (
    <div className="space-y-3" data-testid="base-view">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label={t('bases.views')} className="flex flex-wrap gap-1">
          {answer.views.map((item, index) => (
            <button key={index} type="button" role="tab" aria-selected={index === answer.view} onClick={() => setView(index)} className={'rounded-full border px-3 py-0.5 text-sm ' + (index === answer.view ? 'border-accent-500 bg-accent-500/10 text-accent-300' : 'border-ink-700 text-mist-400 hover:text-mist-100')}>
              {item.name}
            </button>
          ))}
        </div>
        <span className="text-xs text-mist-500">{t('bases.count', { count: answer.total })}</span>
        <span className="flex-1" />
        {source.kind === 'file' && (
          <button type="button" onClick={() => setYaml(yaml === null ? (answer.text ?? '') : null)} className="rounded-full border border-ink-700 px-3 py-0.5 text-sm text-mist-300 hover:bg-ink-850">
            {yaml === null ? t('bases.editYaml') : t('common.cancel')}
          </button>
        )}
      </div>
      {yaml !== null && (
        <div className="space-y-2">
          <textarea value={yaml} onChange={(event) => setYaml(event.target.value)} spellCheck={false} aria-label={t('bases.yaml')} className="h-64 w-full rounded-lg border border-ink-700 bg-ink-950 p-3 font-mono text-xs text-mist-100" />
          <p className="text-xs text-mist-500">{t('bases.yamlHint')}</p>
          <div className="flex justify-end"><button type="button" onClick={() => void saveYaml()} className="rounded-full bg-accent-500 px-3 py-1 text-sm font-semibold text-on-accent">{t('common.save')}</button></div>
        </div>
      )}
      {answer.problems.length > 0 && (
        <ul className="space-y-0.5 text-xs text-warn-500">
          {answer.problems.map((item, index) => <li key={index}>{item}</li>)}
        </ul>
      )}
      {problem && <p role="alert" className="text-sm text-bad-500">{problem}</p>}
      {all.length === 0 ? (
        <p className="text-sm text-mist-500">{t('bases.empty')}</p>
      ) : answer.kind === 'table' ? (
        <div className="overflow-x-auto rounded-xl border border-ink-700">
          <table className="w-full text-sm" data-testid="base-table">
            <thead>
              <tr>
                {answer.columns.map((column) => (
                  <th key={column.key} className="border-b border-ink-700 bg-ink-900 px-2 py-1.5 text-left text-xs font-semibold text-mist-400">{column.label}</th>
                ))}
              </tr>
            </thead>
            {answer.groups.map((group, index) => (
              <tbody key={index}>
                {answer.group && (
                  <tr><td colSpan={answer.columns.length} className="bg-ink-850 px-2 py-1 text-xs font-semibold text-mist-300">{group.value || t('bases.none')}</td></tr>
                )}
                {group.rows.map((row) => (
                  <tr key={row.path} className="border-b border-ink-800 last:border-0">
                    {answer.columns.map((column) => (
                      <td key={column.key} className="px-2 py-1 align-top text-mist-200">{column.key === 'file.name' ? title(row) : cell(row, column.key)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      ) : answer.kind === 'board' ? (
        <div className="flex gap-3 overflow-x-auto pb-2" data-testid="base-board">
          {answer.groups.map((group) => (
            <section
              key={group.value ?? ''}
              aria-label={group.value || t('bases.none')}
              className="w-64 shrink-0 rounded-xl border border-ink-700 bg-ink-900 p-2"
              onDragOver={(event) => dragged && answer.group && event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                if (!dragged || !answer.group || !writable(answer.group)) return
                const before = dragged.cells[answer.group]
                setDragged(null)
                if ((group.value ?? '') !== (Array.isArray(before) ? before.join(', ') : String(before ?? ''))) void write(dragged.path, answer.group, group.value || null)
              }}
            >
              <h3 className="mb-2 flex items-center justify-between px-1 text-sm font-semibold text-mist-200">
                {group.value || t('bases.none')} <span className="text-xs text-mist-500">{group.rows.length}</span>
              </h3>
              {group.rows.map((row) => (
                <div key={row.path} draggable onDragStart={() => setDragged(row)} onDragEnd={() => setDragged(null)} className="mb-2 cursor-grab rounded-lg border border-ink-700 bg-ink-850 p-2 text-sm" data-testid="base-card">
                  {title(row)}
                  {rest.filter((column) => column.key !== answer.group).slice(0, 3).map((column) => (
                    <div key={column.key} className="mt-0.5 truncate text-xs text-mist-500">{column.label}: {shown(row.cells[column.key], column.key)}</div>
                  ))}
                </div>
              ))}
            </section>
          ))}
        </div>
      ) : answer.kind === 'cards' ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-3" data-testid="base-cards">
          {all.map((row) => (
            <div key={row.path} className="overflow-hidden rounded-xl border border-ink-700 bg-ink-850" data-testid="base-card">
              <div className="h-16" style={{ background: `linear-gradient(135deg, ${folderColor(row.path)}, transparent)` }} />
              <div className="space-y-0.5 p-3 text-sm">
                {title(row)}
                {rest.slice(0, 4).map((column) => (
                  <div key={column.key} className="truncate text-xs text-mist-500">{column.label}: {shown(row.cells[column.key], column.key)}</div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <ul className="space-y-1" data-testid="base-list">
          {all.map((row) => (
            <li key={row.path} className="flex flex-wrap items-baseline gap-x-3 text-sm">
              <Symbol name="note" className="h-3.5 w-3.5 translate-y-0.5 text-mist-600" />
              {title(row)}
              {rest.slice(0, 4).map((column) => (
                <span key={column.key} className="text-xs text-mist-500">{shown(row.cells[column.key], column.key)}</span>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
