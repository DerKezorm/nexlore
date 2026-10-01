/**
 * The command palette on Ctrl+P: every command of the page in front, found by typing, run with Enter. Looks like the
 * quick switcher on Ctrl+K, which finds notes. The keyboard beside a command sets own keys for it (`lib/shortcuts.ts`):
 * the next combination pressed is kept with the account.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { allCommands, matchCommands, recentCommands, rememberCommand, type Command } from '../lib/commands'
import { DEFAULT_APPEARANCE } from '../lib/appearance'
import { comboOf, refusal, setRecording, shownCombo, withKey } from '../lib/shortcuts'
import { useAuth } from '../state/auth'
import { Symbol } from './Symbol'

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const { me, setAppearance } = useAuth()
  const own = (me?.appearance ?? DEFAULT_APPEARANCE).keys ?? {}
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  // Read once when opened: what the page offers at this moment.
  const [commands] = useState(allCommands)
  const [recent] = useState(recentCommands)
  const shown = useMemo(() => matchCommands(commands, query, recent), [commands, query, recent])
  // Listening for new keys for this command, and what was said about the last try.
  const [recording, setRecordingFor] = useState<Command | null>(null)
  const [said, setSaid] = useState<{ text: string; bad: boolean } | null>(null)

  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])
  useEffect(() => {
    setRecording(recording !== null)
    return () => setRecording(false)
  }, [recording])

  const run = (command: Command) => {
    rememberCommand(command.id)
    onClose()
    // After the dialog is gone: a command may open a dialog of its own or move the focus.
    window.setTimeout(command.run, 0)
  }

  const record = (command: Command) => {
    setRecordingFor(command)
    setSaid(null)
    input.current?.focus()
  }

  /** A key pressed while listening: kept, removed, refused or given up. */
  const listen = (e: React.KeyboardEvent<HTMLInputElement>, command: Command) => {
    e.preventDefault()
    e.stopPropagation()
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey
    if (plain && e.key === 'Escape') return setRecordingFor(null)
    if (plain && (e.key === 'Delete' || e.key === 'Backspace')) {
      setRecordingFor(null)
      if (!own[command.id]) return
      setSaid({ text: t('shortcuts.removed', { name: command.label }), bad: false })
      void setAppearance({ keys: withKey(own, command.id, command.label, null) })
      return
    }
    const combo = comboOf(e.nativeEvent)
    if (!combo) return
    const why = refusal(combo)
    if (why) return setSaid({ text: t(`shortcuts.${why}`), bad: true })
    setRecordingFor(null)
    setSaid({ text: t('shortcuts.saved', { combo: shownCombo(combo, undefined, i18n.language), name: command.label }), bad: false })
    void setAppearance({ keys: withKey(own, command.id, command.label, combo) })
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
              if (recording) return listen(e, recording)
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
            onBlur={() => setRecordingFor(null)}
            placeholder={t('palette.placeholder')}
            aria-label={t('palette.placeholder')}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            className="h-12 flex-1 bg-transparent text-[15px] text-mist-100 outline-none placeholder:text-mist-600"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
            className="grid h-8 min-w-8 place-items-center rounded border border-ink-700 px-1.5 text-[11px] text-mist-500 hover:bg-ink-850 hover:text-mist-200"
          >
            <span className="hidden sm:inline">Esc</span>
            <Symbol name="close" className="h-4 w-4 sm:hidden" />
          </button>
        </div>
        {(recording || said) && (
          <p
            className={'border-b border-ink-700 px-4 py-2 text-xs ' + (recording ? 'text-accent-400' : said?.bad ? 'text-bad-400' : 'text-mist-400')}
            role="status"
            data-testid="palette-keys"
          >
            {recording ? t('shortcuts.press', { name: recording.label }) : said?.text}
            {recording && said?.bad && <span className="ml-2 text-bad-400">{said.text}</span>}
          </p>
        )}
        <ul ref={list} id="palette-list" role="listbox" className="nn-scroll max-h-[50vh] overflow-y-auto p-2">
          {shown.map((command, i) => {
            // One way of writing keys, the app's own and the account's alike.
            const keys = own[command.id] ? shownCombo(own[command.id].combo, undefined, i18n.language) : command.keys && shownCombo(command.keys, undefined, i18n.language)
            return (
              <li key={command.id} role="option" aria-selected={i === index} className="group flex items-center gap-1">
                <button
                  type="button"
                  data-active={i === index}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => run(command)}
                  className={'flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2 text-left text-sm ' + (i === index ? 'bg-accent-500/12 text-mist-100' : 'text-mist-300')}
                >
                  <Symbol name={command.symbol ?? 'command'} className="h-4 w-4 shrink-0 text-mist-500" />
                  <span className="min-w-0 flex-1 truncate">{command.label}</span>
                  <span className="shrink-0 text-xs text-mist-600">{command.group}</span>
                  {keys && (
                    <kbd className={'hidden shrink-0 rounded border px-1.5 text-[11px] sm:inline ' + (own[command.id] ? 'border-accent-500/40 text-accent-400' : 'border-ink-700 text-mist-500')} data-own={own[command.id] ? 'true' : undefined}>
                      {keys}
                    </kbd>
                  )}
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => record(command)}
                  aria-label={t('shortcuts.set', { name: command.label })}
                  title={t('shortcuts.set', { name: command.label })}
                  aria-pressed={recording?.id === command.id}
                  className={
                    'hidden shrink-0 rounded-lg p-1.5 hover:bg-ink-850 hover:text-mist-100 sm:block ' +
                    (recording?.id === command.id ? 'text-accent-400' : 'text-mist-600 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 ' + (i === index ? 'opacity-100' : ''))
                  }
                  data-testid="set-keys"
                >
                  <Symbol name="keyboard" className="h-4 w-4" />
                </button>
              </li>
            )
          })}
          {shown.length === 0 && <li className="px-3 py-6 text-center text-sm text-mist-500">{t('palette.nothing')}</li>}
        </ul>
      </div>
    </div>
  )
}
