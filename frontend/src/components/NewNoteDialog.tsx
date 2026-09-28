/**
 * A new note in a folder (M6): a title, and a template of the space to start from, with a preview whose placeholders
 * are filled in by the server just as the note will be. Templater commands are shown, never run.
 *
 * The folder it goes to is shown on top and can be changed ("Change"): every space one may write in, opened as it is
 * asked for. The templates follow the space chosen (each space has a templates folder of its own).
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, everydayApi, type Template, vaultApi } from '../api/client'
import { showModalOnce } from '../lib/dialog'
import { errorText } from '../lib/errors'
import { ensureFolder, TEMPLATE_START } from '../lib/folders'
import { useStore } from '../state/store'
import { FolderTree } from './FolderTree'
import { Symbol } from './Symbol'

const TEMPLATER = /<%[\s\S]*?%>/

export function NewNoteDialog({ folder, onClose, onCreated }: { folder: string; onClose: () => void; onCreated: (path: string) => void }) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const { spaces } = useStore()
  const [where, setWhere] = useState(folder)
  const [choosing, setChoosing] = useState(false)
  const space = where.split('/')[0]
  const writable = spaces.filter((item) => item.role === 'write' || item.role === 'manage').map((item) => item.name)
  const [title, setTitle] = useState('')
  const [templates, setTemplates] = useState<Template[] | null>(null)
  const [templateFolder, setTemplateFolder] = useState('')
  const [picked, setPicked] = useState('')
  const [preview, setPreview] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    showModalOnce(dialog.current)
  }, [])

  useEffect(() => {
    let alive = true
    // Another space, other templates: the one picked belonged to the space before.
    setPicked('')
    setTemplates(null)
    void Promise.all([everydayApi.templates(space), everydayApi.options(space)])
      .then(([list, options]) => {
        if (!alive) return
        setTemplates(list)
        setTemplateFolder(options.template_folder)
      })
      .catch((error) => {
        if (!alive) return
        setTemplates([])
        setProblem(error instanceof ApiError ? error.code : 'internal_error')
      })
    return () => {
      alive = false
    }
  }, [space])

  useEffect(() => {
    if (!picked) return
    let alive = true
    const timer = setTimeout(() => {
      everydayApi
        .preview(picked, title.trim())
        .then((answer) => alive && setPreview(answer.content))
        .catch(() => alive && setPreview(''))
    }, 200)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [picked, title])

  const create = async () => {
    if (!title.trim() || busy) return
    setBusy(true)
    setProblem(null)
    try {
      const note = await vaultApi.create(where, title.trim(), '', picked || undefined)
      onCreated(note.path)
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    } finally {
      setBusy(false)
    }
  }

  /** A new template in the space's templates folder (made if it is not there yet), opened for writing. */
  const makeTemplate = async () => {
    setBusy(true)
    setProblem(null)
    try {
      const folderPath = `${space}/${templateFolder || 'Templates'}`
      await ensureFolder(folderPath)
      const made = await vaultApi.create(folderPath, t('newNote.templateName'), TEMPLATE_START)
      onCreated(made.path)
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    } finally {
      setBusy(false)
    }
  }

  const shown = picked ? preview : ''
  return (
    <dialog
      ref={dialog}
      aria-labelledby="new-note-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      className="m-auto w-[min(42rem,calc(100vw-1.5rem))] rounded-2xl border border-ink-700 bg-ink-900 p-0 text-mist-200 shadow-2xl backdrop:bg-scrim"
      data-testid="new-note-dialog"
    >
      <form
        className="flex max-h-[88vh] flex-col"
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <div className="flex items-start gap-3 border-b border-ink-700 px-4 py-3 sm:px-5">
          <h2 id="new-note-title" className="min-w-0 flex-1 text-base font-semibold break-words text-mist-100">
            {t('newNote.title', { folder: where.split('/').join(' / ') })}
          </h2>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="rounded-full p-1 text-mist-500 hover:bg-ink-850">
            <Symbol name="close" />
          </button>
        </div>
        <div className="grid min-h-0 gap-4 overflow-y-auto p-4 sm:grid-cols-[12rem_1fr] sm:p-5">
          <div className="text-sm sm:col-span-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-mist-500">{t('newNote.where')}</span>
              <span className="min-w-0 flex-1 truncate text-mist-200" data-testid="new-note-where">{where.split('/').join(' / ')}</span>
              <button
                type="button"
                aria-expanded={choosing}
                onClick={() => setChoosing((open) => !open)}
                className="rounded-full border border-ink-700 px-2.5 py-0.5 text-xs text-mist-300 hover:bg-ink-850"
              >
                {choosing ? t('newNote.chosen') : t('newNote.change')}
              </button>
            </div>
            {choosing && (
              <div className="mt-2">
                <FolderTree
                  roots={writable}
                  selected={where}
                  onSelect={(at) => {
                    setWhere(at)
                    setChoosing(false)
                  }}
                />
              </div>
            )}
          </div>
          <label className="block text-sm sm:col-span-2">
            <span className="text-xs text-mist-500">{t('newNote.name')}</span>
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="mt-1 h-9 w-full rounded-xl border border-ink-700 bg-ink-850 px-3 text-sm text-mist-100 outline-none focus:border-accent-500"
            />
          </label>
          <div>
            <p className="mb-1 text-xs text-mist-500">
              {t('newNote.template')}
              {templateFolder && <span className="text-mist-600"> ({t('newNote.folder', { folder: templateFolder })})</span>}
            </p>
            <ul className="space-y-1" role="radiogroup" aria-label={t('newNote.template')}>
              {[{ path: '', title: t('newNote.blank') }, ...(templates ?? [])].map((template) => (
                <li key={template.path || 'blank'}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={picked === template.path}
                    onClick={() => setPicked(template.path)}
                    className={
                      'flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm ' +
                      (picked === template.path ? 'bg-accent-500/15 text-accent-400' : 'text-mist-300 hover:bg-ink-850')
                    }
                  >
                    <Symbol name={template.path ? 'template' : 'note'} className="h-4 w-4 shrink-0" />
                    <span className="truncate">{template.title}</span>
                  </button>
                </li>
              ))}
            </ul>
            {templates && templates.length === 0 && !problem && <p className="mt-2 text-xs text-mist-600">{t('newNote.noTemplates')}</p>}
            {writable.includes(space) && (
              <button
                type="button"
                onClick={() => void makeTemplate()}
                disabled={busy}
                className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-ink-700 px-2.5 py-1 text-xs text-mist-300 hover:bg-ink-850"
              >
                <Symbol name="plus" className="h-3.5 w-3.5" /> {t('newNote.makeTemplate')}
              </button>
            )}
            <p className="mt-2 text-[11px] leading-4 text-mist-600">{t('newNote.placeholders')}</p>
          </div>
          <div className="min-w-0">
            <p className="mb-1 text-xs text-mist-500">{t('newNote.preview')}</p>
            <pre className="h-44 overflow-auto rounded-xl border border-ink-700 bg-ink-950 p-3 text-xs whitespace-pre-wrap text-mist-300 sm:h-56" data-testid="template-preview">
              {shown || t('newNote.empty')}
            </pre>
            {TEMPLATER.test(shown) && (
              <p className="mt-2 flex gap-2 text-xs text-warn-500">
                <Symbol name="alert" className="h-4 w-4 shrink-0" />
                {t('newNote.templater')}
              </p>
            )}
          </div>
        </div>
        {problem && <p className="px-5 text-sm text-bad-500">{errorText(problem)}</p>}
        <div className="flex justify-end gap-2 border-t border-ink-700 px-4 py-3 sm:px-5">
          <button type="button" onClick={onClose} className="rounded-full px-4 py-1.5 text-sm text-mist-400 hover:bg-ink-850">
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={!title.trim() || busy} className="rounded-full bg-accent-500 px-4 py-1.5 text-sm font-semibold text-on-accent disabled:opacity-50">
            {t('newNote.create')}
          </button>
        </div>
      </form>
    </dialog>
  )
}
