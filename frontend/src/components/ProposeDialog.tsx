/**
 * A reader proposes a change: the note's Markdown to change, a message for the writers. Nothing of the note changes;
 * the writers of the space see the proposal on the note and take it over or turn it down.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, proposalsApi } from '../api/client'
import { showModalOnce } from '../lib/dialog'
import { errorText } from '../lib/errors'

type Props = { path: string; title: string; content: string; baseHash: string; onClose: () => void; onSent: () => void }

export function ProposeDialog({ path, title, content, baseHash, onClose, onSent }: Props) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const [text, setText] = useState(content)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => showModalOnce(dialog.current), [])
  const send = async () => {
    setBusy(true)
    setProblem(null)
    try {
      await proposalsApi.propose(path, text, baseHash, message.trim())
      onSent()
    } catch (error) {
      setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      aria-labelledby="propose-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
      className="m-auto w-[min(56rem,calc(100vw-2rem))] rounded-2xl border border-ink-700 bg-ink-900 p-0 text-mist-200 shadow-2xl backdrop:bg-scrim"
      data-testid="propose-dialog"
    >
      <form
        className="flex max-h-[88vh] flex-col gap-3 p-5"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <h2 id="propose-title" className="text-base font-semibold text-mist-100">{t('proposals.title', { title })}</h2>
        <p className="text-sm text-mist-400">{t('proposals.text')}</p>
        <textarea value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} aria-label={t('proposals.content')} className="min-h-72 flex-1 rounded-lg border border-ink-700 bg-ink-950 p-3 font-mono text-[13px] text-mist-100" />
        <input value={message} onChange={(event) => setMessage(event.target.value)} maxLength={500} aria-label={t('proposals.message')} placeholder={t('proposals.messageHint')} className="h-9 rounded-lg border border-ink-700 bg-ink-950 px-3 text-sm" />
        {problem && <p role="alert" className="text-sm text-bad-500">{problem}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-full border border-ink-700 px-3 py-1 text-sm text-mist-300 hover:bg-ink-850">{t('common.cancel')}</button>
          <button type="submit" disabled={busy || text === content} className="rounded-full bg-accent-500 px-3 py-1 text-sm font-semibold text-on-accent disabled:opacity-40">{t('proposals.send')}</button>
        </div>
      </form>
    </dialog>
  )
}
