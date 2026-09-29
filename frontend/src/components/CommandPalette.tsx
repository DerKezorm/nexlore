/**
 * The command palette on Ctrl+P: every command of the page in front, found by typing, run with Enter. Looks like the
 * quick switcher on Ctrl+K, which finds notes.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { allCommands, matchCommands, recentCommands, rememberCommand, type Command } from '../lib/commands'
import { Symbol } from './Symbol'

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  // Read once when opened: what the page offers at this moment.
  const [commands] = useState(allCommands)
  const [recent] = useState(recentCommands)
  const shown = useMemo(() => matchCommands(commands, query, recent), [commands, query, recent])

  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const run = (command: Command) => {
    rememberCommand(command.id)
    onClose()
    // After the dialog is gone: a command may open a dialog of its own or move the focus.
    window.setTimeout(command.run, 0)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-scrim/70 px-4 pt-[12vh]" onMouseDown={onClose}>
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 shadow-2xl" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={t('palette.title')}>
        <div className="flex items-center gap-3 border-b border-ink-700 px-4">
          <Symbol name="command" className="h-4 w-4 text-mist-500" />
          <input
            ref={input}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setIndex(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIndex((i) => Math.min(shown.length - 1, i + 1))
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIndex((i) => Math.max(0, i - 1))
              }
              if (e.key === 'Enter' && shown[index]) run(shown[index])
            }}
            placeholder={t('palette.placeholder')}
            aria-label={t('palette.placeholder')}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            className="h-12 flex-1 bg-transparent text-[15px] text-mist-100 outline-none placeholder:text-mist-600"
          />
          <kbd className="rounded border border-ink-700 px-1.5 text-[11px] text-mist-500">Esc</kbd>
        </div>
        <ul ref={list} id="palette-list" role="listbox" className="nn-scroll max-h-[50vh] overflow-y-auto p-2">
          {shown.map((command, i) => (
            <li key={command.id} role="option" aria-selected={i === index}>
              <button
                type="button"
                data-active={i === index}
                onMouseEnter={() => setIndex(i)}
                onClick={() => run(command)}
                className={'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm ' + (i === index ? 'bg-accent-500/12 text-mist-100' : 'text-mist-300')}
              >
                <Symbol name={command.symbol ?? 'command'} className="h-4 w-4 shrink-0 text-mist-500" />
                <span className="min-w-0 flex-1 truncate">{command.label}</span>
                <span className="shrink-0 text-xs text-mist-600">{command.group}</span>
                {command.keys && <kbd className="hidden shrink-0 rounded border border-ink-700 px-1.5 text-[11px] text-mist-500 sm:inline">{command.keys}</kbd>}
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="px-3 py-6 text-center text-sm text-mist-500">{t('palette.nothing')}</li>}
        </ul>
      </div>
    </div>
  )
}
