/**
 * Choosing a template of the note's space to put into the note at the caret (review before 1.0.0, P5.24): its
 * placeholders filled for this note, as a new note from it would get them.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { everydayApi, type Template } from '../api/client'
import { showModalOnce } from '../lib/dialog'
import { Symbol } from './Symbol'

export function TemplatePicker({ space, onPick, onClose }: { space: string; onPick: (path: string) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const [templates, setTemplates] = useState<Template[] | null>(null)

  useEffect(() => {
    showModalOnce(dialog.current)
    let live = true
    everydayApi
      .templates(space)
      .then((list) => live && setTemplates(list))
      .catch(() => live && setTemplates([]))
    return () => {
      live = false
    }
  }, [space])

  return (
    <dialog
      ref={dialog}
      aria-labelledby="template-picker-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      className="m-auto w-[min(26rem,calc(100vw-1.5rem))] rounded-2xl border border-ink-700 bg-ink-900 p-0 text-mist-200 shadow-2xl backdrop:bg-scrim"
    >
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <h2 id="template-picker-title" className="text-base font-semibold text-mist-100">
            {t('insert.template')}
          </h2>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="rounded-full p-1 text-mist-500 hover:bg-ink-850">
            <Symbol name="close" />
          </button>
        </div>
        {templates === null ? (
          <p className="mt-3 text-sm text-mist-500">{t('common.loading')}</p>
        ) : templates.length === 0 ? (
          <p className="mt-3 text-sm text-mist-500">{t('insert.noTemplates')}</p>
        ) : (
          <ul className="mt-3 max-h-80 overflow-y-auto">
            {templates.map((template) => (
              <li key={template.path}>
                <button
                  type="button"
                  onClick={() => onPick(template.path)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-mist-200 hover:bg-ink-850"
                >
                  <Symbol name="note" className="h-3.5 w-3.5 shrink-0 text-mist-500" />
                  <span className="min-w-0 truncate">{template.path.slice(space.length + 1).replace(/\.md$/i, '')}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </dialog>
  )
}
