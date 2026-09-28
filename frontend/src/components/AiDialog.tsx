/**
 * One AI task in the editor, as in nexmail: the text is read when the dialog opens (the selection, or the whole note),
 * sent to the account's own service, and the result shown next to it. Nothing changes until "Take it over": a comma
 * fix that turned Thursday into Friday would otherwise go unseen. Correcting, rewriting and translating replace what
 * was chosen (one step of undo); a summary or a written text goes in at the caret or into a new note.
 *
 * "Write for me" first asks what to write; the note goes along as material.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { ApiError, aiApi, vaultApi } from '../api/client'
import type { AiScope, NoteEditor } from '../editor/editor'
import type { AiAsk } from '../lib/aiMenu'
import { showModalOnce } from '../lib/dialog'
import { errorText } from '../lib/errors'
import { baseName, folderOf, noteUrl } from '../lib/vault'
import { CompareRows } from './CompareRows'

type Props = {
  engine: NoteEditor
  ask: AiAsk
  notePath: string
  onClose: () => void
  onNotice: (text: string) => void
}

const words = (text: string) => text.split(/\s+/).filter(Boolean).length

export function AiDialog({ engine, ask, notePath, onClose, onNotice }: Props) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const dialog = useRef<HTMLDialogElement>(null)
  // Read once, now: once the focus is in the dialog the selection is gone.
  const [scope] = useState<AiScope>(() => engine.aiScope())
  const writing = ask.task === 'write'
  const [instruction, setInstruction] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const alive = useRef(true)
  const tooShort = !writing && words(scope.markdown) < 3

  const send = async () => {
    setBusy(true)
    setProblem(null)
    try {
      const answer = await aiApi.run(ask.task, scope.markdown, ask.target, instruction)
      if (alive.current) setResult(answer.text)
    } catch (error) {
      if (alive.current) setProblem(error instanceof ApiError ? error.code : 'internal_error')
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  useEffect(() => {
    alive.current = true
    showModalOnce(dialog.current)
    if (!writing && !tooShort) void send()
    return () => {
      alive.current = false
    }
    // Once, when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const replaces = ask.task === 'spelling' || ask.task === 'rewrite' || ask.task === 'translate'
  const heading = writing
    ? t('ai.writeTitle')
    : `${t(`ai.tasks.${ask.task}`)}${ask.target ? ` · ${ask.task === 'rewrite' ? t(`ai.tones.${ask.target}`) : t(`ai.languages.${ask.target}`)}` : ''}`
  const scopeLine = t(scope.whole ? 'ai.scopeNote' : 'ai.scopeSelection', { count: words(scope.markdown) })

  const asNote = async () => {
    if (result === null) return
    setBusy(true)
    try {
      const wanted = title.trim() || `${baseName(notePath).replace(/\.md$/i, '')} · ${t(`ai.tasks.${ask.task}`)}`
      const made = await vaultApi.create(folderOf(notePath), wanted, result)
      onNotice(t('ai.madeNote', { title: wanted }))
      onClose()
      navigate(noteUrl(made.path))
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby="ai-dialog-title"
      data-testid="ai-dialog"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      className="m-auto max-h-[90vh] w-[min(72rem,calc(100vw-2rem))] rounded-2xl border border-ink-700 bg-ink-950 p-0 text-mist-200 shadow-2xl backdrop:bg-scrim"
    >
      <div className="flex max-h-[90vh] flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-ink-700 px-5 py-3">
          <h2 id="ai-dialog-title" className="min-w-0 flex-1 text-base font-semibold text-mist-100">
            {heading}
            <span className="ml-2 text-xs font-normal text-mist-500" data-testid="ai-scope">{scopeLine}</span>
          </h2>
          <button type="button" onClick={onClose} className="rounded-full px-3 py-1 text-sm text-mist-400 hover:bg-ink-850">
            {result !== null ? t('ai.discard') : t('common.cancel')}
          </button>
          {result !== null && replaces && (
            <button
              type="button"
              onClick={() => {
                engine.replaceMarkdown(result, scope)
                onNotice(t('ai.taken'))
                onClose()
              }}
              className="rounded-full bg-accent-500 px-3 py-1 text-sm font-semibold text-on-accent"
            >
              {t('ai.takeOver')}
            </button>
          )}
          {result !== null && !replaces && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  engine.insertMarkdown(result)
                  onNotice(t('ai.taken'))
                  onClose()
                }}
                className="rounded-full bg-accent-500 px-3 py-1 text-sm font-semibold text-on-accent"
              >
                {t('ai.insert')}
              </button>
              <button type="button" disabled={busy} onClick={() => void asNote()} className="rounded-full border border-ink-700 px-3 py-1 text-sm text-mist-200 hover:bg-ink-850">
                {t('ai.asNote')}
              </button>
            </>
          )}
        </header>

        {problem && <p role="alert" className="border-b border-bad-500/30 bg-bad-500/10 px-5 py-2 text-sm text-bad-500">{errorText(problem)}</p>}
        {tooShort && <p role="note" className="px-5 py-4 text-sm text-mist-400">{t('ai.tooShort')}</p>}

        {writing && result === null && (
          <form
            className="space-y-3 px-5 py-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (!busy) void send()
            }}
          >
            <label className="block text-sm text-mist-300">
              {t('ai.writeRequest')}
              <textarea
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                maxLength={2000}
                rows={3}
                autoFocus
                placeholder={t('ai.writePlaceholder')}
                className="mt-1 block w-full resize-y rounded-lg border border-ink-700 bg-ink-900 p-2 text-sm text-mist-100 outline-none focus:border-accent-500"
              />
            </label>
            <p className="text-xs text-mist-500">{t('ai.writeMaterial')}</p>
            <button type="submit" disabled={busy || words(instruction) < 3} className="rounded-full bg-accent-500 px-3 py-1 text-sm font-semibold text-on-accent disabled:opacity-50">
              {t('ai.writeRun')}
            </button>
          </form>
        )}

        {busy && result === null && (
          <p role="status" className="px-5 py-4 text-sm text-mist-400">
            {t('ai.working')}
          </p>
        )}

        {result !== null && replaces && (
          <>
            <p className="border-b border-ink-700/60 px-5 py-2 text-xs text-mist-500">{t(scope.whole ? 'ai.untouchedNote' : 'ai.untouched')}</p>
            <div className="grid grid-cols-2 gap-4 border-b border-ink-700/60 px-5 py-2 text-xs font-semibold text-mist-300">
              <div>{t('ai.before')}</div>
              <div>{t('ai.after')}</div>
            </div>
            <CompareRows left={scope.markdown} right={result} testId="ai-rows" />
          </>
        )}

        {result !== null && !replaces && (
          <div className="nn-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
            <div className="text-xs font-semibold text-mist-300">{t('ai.result')}</div>
            <pre className="rounded-lg border border-ink-700 bg-ink-900 p-3 font-mono text-xs whitespace-pre-wrap text-mist-200" data-testid="ai-result">
              {result}
            </pre>
            <label className="block text-xs text-mist-400">
              {t('ai.noteTitle')}
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={200}
                placeholder={`${baseName(notePath).replace(/\.md$/i, '')} · ${t(`ai.tasks.${ask.task}`)}`}
                className="mt-1 block h-8 w-full max-w-md rounded-lg border border-ink-700 bg-ink-900 px-2 text-sm text-mist-100 outline-none focus:border-accent-500"
              />
            </label>
          </div>
        )}
      </div>
    </dialog>
  )
}
