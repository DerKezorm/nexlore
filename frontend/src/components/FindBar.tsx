/**
 * Find and replace in the note being written: a bar above the text. Ctrl+F opens it with the field focused (the
 * selected words in it), Ctrl+H with the row for replacing too. Enter goes to the next hit, Shift+Enter to the one
 * before, F3 and Shift+F3 as well; Escape closes it and puts the caret on the current hit. The reading view keeps
 * the browser's own search.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

import type { NoteEditor } from '../editor/editor'
import type { FindStatus } from '../editor/find'
import { Symbol } from './Symbol'

const NONE: FindStatus = { query: '', caseSensitive: false, count: 0, current: -1, capped: false }

type Props = {
  editor: NoteEditor
  /** The field to focus when the bar opens or is asked again (a counter, so the same ask twice works). */
  focus: { field: 'find' | 'replace'; seed: string | null; ask: number }
  replacing: boolean
  onReplacing: (on: boolean) => void
  onClose: () => void
}

export function FindBar({ editor, focus, replacing, onReplacing, onClose }: Props) {
  const { t } = useTranslation()
  const [query, setQuery] = useState(focus.seed ?? '')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [replacement, setReplacement] = useState('')
  const [status, setStatus] = useState<FindStatus>(NONE)
  const [said, setSaid] = useState('')
  const findField = useRef<HTMLInputElement>(null)
  const replaceField = useRef<HTMLInputElement>(null)
  const frame = useRef(0)

  // The hits follow the text: typing in the note while the bar is open counts again.
  useEffect(() => {
    const update = () => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(() => setStatus(editor.find.status()))
    }
    update()
    const stop = editor.subscribe(update)
    return () => {
      stop()
      cancelAnimationFrame(frame.current)
    }
  }, [editor])

  // Opened or asked again: the words chosen in the text become the search, the field gets the focus.
  useEffect(() => {
    if (focus.seed !== null) {
      setQuery(focus.seed)
      editor.find.search(focus.seed, caseSensitive)
    } else editor.find.search(findField.current?.value ?? '', caseSensitive)
    const field = focus.field === 'replace' ? replaceField.current : findField.current
    field?.focus()
    field?.select()
    // Only a new ask moves the focus; the search itself follows the fields below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.ask])

  // The marks go with the bar.
  useEffect(
    () => () => {
      if (!editor.view.isDestroyed) editor.find.close(false)
    },
    [editor],
  )

  const search = (next: string, sensitive = caseSensitive) => {
    setQuery(next)
    setSaid('')
    editor.find.search(next, sensitive)
  }

  const close = () => {
    editor.find.close(true)
    onClose()
    editor.view.focus()
  }

  const replaceOne = () => {
    editor.find.replace(replacement)
    setSaid('')
  }

  const replaceAll = () => {
    const count = editor.find.replaceAll(replacement)
    setSaid(t('find.replaced', { count }))
  }

  const keys = (event: ReactKeyboardEvent<HTMLInputElement>, where: 'find' | 'replace') => {
    const mod = event.ctrlKey || event.metaKey
    if (event.key === 'Escape') {
      event.preventDefault()
      return close()
    }
    // F3 goes up to the editor's frame, which steps from the bar and from the text alike.
    if (mod && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      findField.current?.focus()
      return findField.current?.select()
    }
    if (mod && !event.altKey && event.key.toLowerCase() === 'h') {
      event.preventDefault()
      onReplacing(true)
      return requestAnimationFrame(() => replaceField.current?.focus())
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (where === 'replace') return mod ? replaceAll() : replaceOne()
    return event.shiftKey ? editor.find.previous() : editor.find.next()
  }

  const shown = status.query === query ? status : NONE
  const total = shown.capped ? `${shown.count}+` : String(shown.count)
  const counter = !query ? '' : shown.count ? t('find.count', { current: shown.current + 1, count: total }) : t('find.none')
  const tool = 'inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md px-1 text-mist-300 hover:bg-ink-850 hover:text-mist-100 disabled:opacity-35 disabled:hover:bg-transparent'
  const field = 'h-7 min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-950 px-2 text-sm text-mist-100 outline-none placeholder:text-mist-600 focus:border-accent-500'

  return (
    <div role="search" aria-label={t('find.label')} data-testid="find-bar" className="flex flex-col gap-1 py-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={tool}
          aria-label={t('find.toggleReplace')}
          title={t('find.toggleReplace')}
          aria-expanded={replacing}
          onClick={() => onReplacing(!replacing)}
        >
          <Symbol name={replacing ? 'chevronDown' : 'chevronRight'} className="h-4 w-4" />
        </button>
        <div className="relative flex min-w-0 flex-1 items-center">
          <input
            ref={findField}
            value={query}
            onChange={(event) => search(event.target.value)}
            onKeyDown={(event) => keys(event, 'find')}
            placeholder={t('find.placeholder')}
            aria-label={t('find.placeholder')}
            spellCheck={false}
            className={field + ' pr-24'}
            data-testid="find-input"
          />
          <span aria-live="polite" data-testid="find-count" className="pointer-events-none absolute right-2 text-xs whitespace-nowrap text-mist-500">
            {counter}
          </span>
        </div>
        <button
          type="button"
          className={tool + ' text-xs font-semibold' + (caseSensitive ? ' bg-accent-500/15 text-accent-400' : '')}
          aria-label={t('find.caseSensitive')}
          title={t('find.caseSensitive')}
          aria-pressed={caseSensitive}
          onClick={() => {
            setCaseSensitive(!caseSensitive)
            search(query, !caseSensitive)
          }}
        >
          Aa
        </button>
        <button type="button" className={tool} aria-label={t('find.previous')} title={t('find.previous')} disabled={!shown.count} onClick={() => editor.find.previous()}>
          <Symbol name="chevronUp" className="h-4 w-4" />
        </button>
        <button type="button" className={tool} aria-label={t('find.next')} title={t('find.next')} disabled={!shown.count} onClick={() => editor.find.next()}>
          <Symbol name="chevronDown" className="h-4 w-4" />
        </button>
        <button type="button" className={tool} aria-label={t('find.close')} title={t('find.close')} onClick={close}>
          <Symbol name="close" className="h-4 w-4" />
        </button>
      </div>
      {replacing && (
        <div className="flex items-center gap-1 pl-8">
          <input
            ref={replaceField}
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={(event) => keys(event, 'replace')}
            placeholder={t('find.replacePlaceholder')}
            aria-label={t('find.replacePlaceholder')}
            spellCheck={false}
            className={field}
            data-testid="replace-input"
          />
          <button type="button" className={tool + ' px-2 text-xs'} disabled={!shown.count} onClick={replaceOne}>
            {t('find.replace')}
          </button>
          <button type="button" className={tool + ' px-2 text-xs'} disabled={!shown.count} onClick={replaceAll}>
            {t('find.replaceAll')}
          </button>
        </div>
      )}
      {said && (
        <p role="status" className="pl-8 text-xs text-mist-500">
          {said}
        </p>
      )}
    </div>
  )
}
