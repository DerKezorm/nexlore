/**
 * The front matter as a table of properties above the text, like Obsidian: a name and a value per row, lists
 * (tags, aliases) as chips, dates with a calendar, yes/no as a box. Folds away. Only what changes is written back
 * (frontmatter.ts); YAML that is not a list of names and values is edited as text.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { locale } from '../i18n'
import { shownDate } from '../lib/markdown'

import { headYaml, readProperties, writeProperties, writeYaml, type Property, type PropertyKind } from '../editor/frontmatter'

type Props = {
  head: string
  readOnly?: boolean
  onChange: (head: string) => void
}

const KINDS: PropertyKind[] = ['text', 'list', 'number', 'checkbox', 'date', 'datetime']

export function Properties({ head, readOnly = false, onChange }: Props) {
  const { t } = useTranslation()
  const parsed = useMemo(() => readProperties(head), [head])
  const [open, setOpen] = useState(true)
  // Rows being edited; a row without a name is not written yet.
  const [draft, setDraft] = useState<Property[] | null>(null)
  const items = draft ?? (parsed.ok ? parsed.items : [])
  // The head this table wrote last. Another one came from outside (the note was loaded again): the rows follow it,
  // or the next keystroke would write the old properties over the new ones.
  const written = useRef(head)
  useEffect(() => {
    if (head === written.current) return
    written.current = head
    setDraft(null)
  }, [head])

  if (!head && readOnly) return null

  const commit = (next: Property[]) => {
    setDraft(next)
    const named = next.filter((item, index) => item.key.trim() && next.findIndex((other) => other.key.trim() === item.key.trim()) === index)
    const nextHead = writeProperties(head, named.map((item) => ({ ...item, key: item.key.trim() })))
    written.current = nextHead
    onChange(nextHead)
  }
  const update = (index: number, change: Partial<Property>) => commit(items.map((item, i) => (i === index ? { ...item, ...change } : item)))

  if (!parsed.ok) {
    return (
      <section className="nx-properties mb-5 rounded-xl border border-ink-700 bg-ink-900/60 px-3 py-2" aria-label={t('properties.title')}>
        <p className="mb-2 text-xs text-warn-500">{t('properties.notYaml')}</p>
        <textarea
          defaultValue={headYaml(head)}
          readOnly={readOnly}
          spellCheck={false}
          aria-label={t('properties.yaml')}
          onChange={(event) => onChange(writeYaml(head, event.target.value))}
          className="h-32 w-full rounded-lg border border-ink-700 bg-ink-950 p-2 font-mono text-xs text-mist-200 outline-none focus:border-accent-500"
        />
      </section>
    )
  }

  // Folded with no property in it the row stays: its arrow is the only way to open it again.
  return (
    <section className="nx-properties mb-5" aria-label={t('properties.title')}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-mist-500 uppercase hover:text-mist-300"
      >
        <span className={'inline-block transition-transform ' + (open ? 'rotate-90' : '')}>›</span>
        {t('properties.title')}
        {items.length > 0 && <span className="font-normal text-mist-600 tabular-nums">{items.length}</span>}
      </button>
      {open && (
        <div className="space-y-0.5">
          {items.map((item, index) => {
            // A second row with a name already taken is not written (it would replace the first): said so.
            const taken = !!item.key.trim() && items.findIndex((other) => other.key.trim() === item.key.trim()) < index
            return (
            <div key={index} className="group flex flex-wrap items-start gap-2 rounded-lg px-1 py-0.5 hover:bg-ink-850">
              <input
                value={item.key}
                readOnly={readOnly}
                placeholder={t('properties.name')}
                aria-label={t('properties.name')}
                aria-invalid={taken || undefined}
                aria-describedby={taken ? `property-taken-${index}` : undefined}
                onChange={(event) => update(index, { key: event.target.value })}
                className={'h-7 w-36 shrink-0 truncate rounded-md bg-transparent px-1.5 text-sm outline-none focus:bg-ink-900 focus:text-mist-100 ' + (taken ? 'text-bad-500' : 'text-mist-400')}
              />
              <div className="min-w-0 flex-1">
                <Value item={item} readOnly={readOnly} onChange={(value) => update(index, { value })} />
              </div>
              {!readOnly && (
                <div className="flex shrink-0 items-center gap-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                  <select
                    value={item.kind === 'other' ? 'text' : item.kind}
                    aria-label={t('properties.kind')}
                    onChange={(event) => update(index, { kind: event.target.value as PropertyKind, value: convert(item, event.target.value as PropertyKind) })}
                    className="h-7 rounded-md border border-ink-700 bg-ink-900 px-1 text-xs text-mist-400"
                  >
                    {KINDS.map((kind) => (
                      <option key={kind} value={kind}>{t(`properties.kinds.${kind}`)}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => commit(items.filter((_, i) => i !== index))}
                    aria-label={t('properties.remove', { name: item.key })}
                    className="h-7 w-7 rounded-md text-mist-500 hover:bg-ink-800 hover:text-bad-500"
                  >
                    ×
                  </button>
                </div>
              )}
              {taken && (
                <p id={`property-taken-${index}`} className="w-full px-1.5 text-xs text-bad-500">
                  {t('properties.duplicate')}
                </p>
              )}
            </div>
            )
          })}
          {!readOnly && (
            <button
              type="button"
              onClick={() => setDraft([...items, { key: '', kind: 'text', value: '' }])}
              className="rounded-lg px-2 py-1 text-sm text-mist-500 hover:bg-ink-850 hover:text-accent-400"
            >
              + {t('properties.add')}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

/** A value in another kind: what can be kept, is. */
function convert(item: Property, kind: PropertyKind): Property['value'] {
  const text = Array.isArray(item.value) ? item.value.join(', ') : String(item.value)
  if (kind === 'list') return Array.isArray(item.value) ? item.value : text ? text.split(/\s*,\s*/).filter(Boolean) : []
  if (kind === 'checkbox') return item.value === true || text === 'true'
  return text === 'false' && item.kind === 'checkbox' ? '' : text
}

/**
 * A date or a date with time. The browser's own date field writes the date the way the computer is set up, not
 * in the app's language; so the date is shown as text, and a click opens the browser's calendar.
 */
function DateValue({ item, readOnly, onChange, className }: { item: Property; readOnly: boolean; onChange: (value: Property['value']) => void; className: string }) {
  const { t, i18n } = useTranslation()
  const picker = useRef<HTMLInputElement>(null)
  const withTime = item.kind === 'datetime'
  const raw = withTime ? String(item.value).replace(' ', 'T') : String(item.value)
  const shown = raw ? shownDate(raw, withTime, i18n.language || locale()) : ''
  const open = () => {
    const input = picker.current
    if (!input) return
    try {
      input.showPicker()
    } catch {
      input.focus()
    }
  }
  return (
    <span className="relative block">
      <button type="button" disabled={readOnly} onClick={open} aria-label={item.key} data-value={raw} className={className + ' text-left disabled:cursor-default'}>
        {shown || <span className="text-mist-600">{t('properties.pickDate')}</span>}
      </button>
      <input
        ref={picker}
        type={withTime ? 'datetime-local' : 'date'}
        value={raw}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => onChange(event.target.value)}
        className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
      />
    </span>
  )
}

function Value({ item, readOnly, onChange }: { item: Property; readOnly: boolean; onChange: (value: Property['value']) => void }) {
  const { t } = useTranslation()
  const [adding, setAdding] = useState('')
  const field = 'h-7 w-full rounded-md bg-transparent px-1.5 text-sm text-mist-100 outline-none focus:bg-ink-900'
  switch (item.kind) {
    case 'checkbox':
      return (
        <input type="checkbox" checked={item.value === true} disabled={readOnly} aria-label={item.key} onChange={(event) => onChange(event.target.checked)} className="mt-1.5 ml-1.5 accent-accent-500" />
      )
    case 'date':
    case 'datetime':
      return <DateValue item={item} readOnly={readOnly} onChange={onChange} className={field} />
    case 'list': {
      const values = item.value as string[]
      const add = () => {
        // A tag is written without its #, as Obsidian does in the front matter.
        const next = item.key.toLowerCase() === 'tags' ? adding.trim().replace(/^#/, '') : adding.trim()
        if (next) onChange([...values, next])
        setAdding('')
      }
      return (
        <div className="flex min-h-7 flex-wrap items-center gap-1 px-1">
          {values.map((value, index) => (
            <span key={index} className="inline-flex items-center gap-1 rounded-full bg-accent-500/12 px-2 py-0.5 text-xs text-accent-400">
              {item.key.toLowerCase() === 'tags' ? '#' : ''}
              {value}
              {!readOnly && (
                <button type="button" aria-label={t('properties.removeValue', { value })} onClick={() => onChange(values.filter((_, i) => i !== index))} className="text-accent-400/70 hover:text-bad-500">
                  ×
                </button>
              )}
            </span>
          ))}
          {!readOnly && (
            <input
              value={adding}
              placeholder={values.length ? '' : t('properties.addValue')}
              aria-label={t('properties.addValueTo', { name: item.key })}
              onChange={(event) => setAdding(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ',') {
                  event.preventDefault()
                  add()
                } else if (event.key === 'Backspace' && !adding && values.length) onChange(values.slice(0, -1))
              }}
              onBlur={add}
              className="h-6 min-w-16 flex-1 bg-transparent text-sm text-mist-100 outline-none"
            />
          )}
        </div>
      )
    }
    case 'other':
      return <textarea value={String(item.value)} readOnly={readOnly} aria-label={item.key} onChange={(event) => onChange(event.target.value)} className={field + ' h-16 font-mono text-xs'} />
    default:
      return <input value={String(item.value)} readOnly={readOnly} aria-label={item.key} inputMode={item.kind === 'number' ? 'decimal' : undefined} onChange={(event) => onChange(event.target.value)} className={field} />
  }
}
