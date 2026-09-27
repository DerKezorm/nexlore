/**
 * Where the daily notes and templates of a space live (M6), set by its managers for everybody in it: the folder for
 * daily notes, the template a new daily note starts from, the folder whose notes are templates.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { everydayApi, type SpaceOptions, type Template } from '../api/client'
import { showModalOnce } from '../lib/dialog'
import { Button, Feedback, Input, Select } from './settings/ui'
import { useAction } from './settings/useAction'
import { Symbol } from './Symbol'

const PLACEHOLDERS = ['{{title}}', '{{date}}', '{{time}}', '{{date:DD.MM.YYYY}}']

export function SpaceOptionsDialog({ space, onClose }: { space: string; onClose: () => void }) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const [options, setOptions] = useState<SpaceOptions | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const { busy, problem, done, run } = useAction()

  useEffect(() => {
    showModalOnce(dialog.current)
    void run(async () => {
      const [found, list] = await Promise.all([everydayApi.options(space), everydayApi.templates(space)])
      setOptions(found)
      setTemplates(list)
    })
  }, [run, space])

  const templateOptions = [
    { value: '', label: t('spaceOptions.none') },
    ...templates.map((template) => ({ value: template.path.slice(space.length + 1), label: template.path.slice(space.length + 1) })),
  ]
  if (options?.daily_template && !templateOptions.some((option) => option.value === options.daily_template)) {
    templateOptions.push({ value: options.daily_template, label: options.daily_template })
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby="space-options-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      className="m-auto w-[min(34rem,calc(100vw-1.5rem))] rounded-2xl border border-ink-700 bg-ink-900 p-0 text-mist-200 shadow-2xl backdrop:bg-scrim"
    >
      <form
        className="max-h-[85vh] overflow-y-auto p-5"
        onSubmit={(event) => {
          event.preventDefault()
          if (!options) return
          void run(async () => setOptions(await everydayApi.setOptions(space, options)), t('spaceOptions.saved'))
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="space-options-title" className="text-base font-semibold text-mist-100">
            {t('spaceOptions.title', { space })}
          </h2>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="rounded-full p-1 text-mist-500 hover:bg-ink-850">
            <Symbol name="close" />
          </button>
        </div>
        <p className="mt-1 text-sm text-mist-500">{t('spaceOptions.text')}</p>
        {options && (
          <div className="mt-4 grid gap-4">
            <Input
              label={t('spaceOptions.dailyFolder')}
              value={options.daily_folder}
              onChange={(value) => setOptions({ ...options, daily_folder: value })}
              hint={t('spaceOptions.rootHint')}
            />
            <Select
              label={t('spaceOptions.dailyTemplate')}
              value={options.daily_template}
              options={templateOptions}
              onChange={(value) => setOptions({ ...options, daily_template: value })}
            />
            <Input
              label={t('spaceOptions.templateFolder')}
              value={options.template_folder}
              onChange={(value) => setOptions({ ...options, template_folder: value })}
            />
            <p className="text-xs text-mist-500">
              {t('spaceOptions.placeholders')}{' '}
              {PLACEHOLDERS.map((placeholder) => (
                <code key={placeholder} className="mr-1.5 text-warn-500">
                  {placeholder}
                </code>
              ))}
            </p>
          </div>
        )}
        <Feedback problem={problem} done={done} />
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.close')}</Button>
          <Button type="submit" primary busy={busy}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </dialog>
  )
}
