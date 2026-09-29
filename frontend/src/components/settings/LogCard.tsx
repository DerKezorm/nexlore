/**
 * The server's log for the operator, under Server: the newest lines, narrowed by level and words, the level of detail
 * (for a while, then back by itself), the whole file to download, and clearing it. Nothing secret is written there
 * (a scan in the tests sees to that), so reading it here shows nothing new about anyone.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { logsApi, type LogLine, type LogMode } from '../../api/client'
import { ConfirmDialog } from '../ConfirmDialog'
import { Button, Card, Feedback, Select } from './ui'
import { useAction } from './useAction'

const LEVELS = ['', 'INFO', 'WARNING', 'ERROR'] as const
type Level = (typeof LEVELS)[number]

export function LogCard() {
  const { t } = useTranslation()
  const [lines, setLines] = useState<LogLine[] | null>(null)
  const [level, setLevel] = useState<Level>('')
  const [words, setWords] = useState('')
  const [mode, setMode] = useState<LogMode | null>(null)
  const [clearing, setClearing] = useState(false)
  const { busy, problem, done, run } = useAction()

  const load = useCallback(
    () => void run(async () => setLines(await logsApi.read(level || undefined, words.trim() || undefined))),
    [level, words, run],
  )
  useEffect(() => {
    const timer = window.setTimeout(load, 250)
    return () => window.clearTimeout(timer)
  }, [load])
  useEffect(() => {
    logsApi.mode().then(setMode, () => {})
  }, [])

  const setDetail = (value: string) =>
    void run(async () => setMode(await logsApi.setMode(value, value === 'detailed' || value === 'trace' ? 60 : 0)))

  const tone = (line: LogLine) =>
    line.level === 'ERROR' || line.level === 'CRITICAL' ? 'text-bad-500' : line.level === 'WARNING' ? 'text-warn-500' : 'text-mist-300'

  return (
    <Card id="log" symbol="info" title={t('log.title')} text={t('log.text')}>
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label={t('log.level')}
          value={level}
          options={LEVELS.map((value) => ({ value, label: value ? value : t('log.all') }))}
          onChange={setLevel}
          className="w-36"
        />
        <label className="min-w-40 flex-1 text-sm text-mist-400">
          {t('log.search')}
          <input
            value={words}
            onChange={(event) => setWords(event.target.value)}
            className="mt-1 h-9 w-full rounded-lg border border-ink-700 bg-ink-850 px-2 text-sm text-mist-100 outline-none focus:border-accent-500"
          />
        </label>
        <Button onClick={load} busy={busy}>
          {t('log.refresh')}
        </Button>
      </div>
      <div
        className="mt-3 max-h-[28rem] overflow-auto rounded-xl border border-ink-700 bg-ink-950 p-3 font-mono text-[11px] leading-5"
        data-testid="log-lines"
        role="log"
      >
        {lines?.length === 0 && <p className="text-mist-500">{t('log.empty')}</p>}
        {lines?.map((line, index) => (
          <div key={index} className={'break-words whitespace-pre-wrap ' + tone(line)}>
            <span className="text-mist-600">{line.time}</span> {line.level} <span className="text-mist-500">{line.logger}</span>{' '}
            {line.message}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        {mode && (
          <Select
            label={mode.fixed_by_env ? t('log.detailFixed') : t('log.detail')}
            value={mode.mode}
            options={mode.modes.map((value) => ({ value, label: t(`log.modes.${value}`, { defaultValue: value }) }))}
            onChange={setDetail}
            className="w-56"
          />
        )}
        <a href="/api/logs/download" className="inline-flex items-center rounded-full border border-ink-700 px-3.5 py-1.5 text-sm text-mist-300 hover:bg-ink-850">
          {t('log.download')}
        </a>
        <Button danger onClick={() => setClearing(true)}>
          {t('log.clear')}
        </Button>
      </div>
      {mode?.until && <p className="mt-2 text-xs text-mist-500">{t('log.until', { time: new Date(mode.until).toLocaleTimeString() })}</p>}
      <Feedback problem={problem} done={done} />
      <ConfirmDialog
        open={clearing}
        title={t('log.clearTitle')}
        confirm={t('log.clear')}
        danger
        busy={busy}
        onCancel={() => setClearing(false)}
        onConfirm={() =>
          void run(async () => {
            await logsApi.clear()
            setClearing(false)
            setLines([])
          }, t('log.cleared'))
        }
      >
        {t('log.clearText')}
      </ConfirmDialog>
    </Card>
  )
}
