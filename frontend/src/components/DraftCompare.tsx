/**
 * A draft an AI proposed over MCP, next to what the note holds now (design answer M7): the same side by side as a
 * conflict copy, the changed words marked, then take it over or throw it away. Taking over saves against the state
 * the AI read: a note changed since gets a conflict copy, never an overwrite (the server says so, `conflict`).
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, draftsApi, type DraftFull } from '../api/client'
import { showModalOnce } from '../lib/dialog'
import { errorText } from '../lib/errors'
import { CompareRows } from './CompareRows'

type Props = {
  draftId: number
  onClose: () => void
  /** Taken over (with the path it went to, and the conflict copy if there was one) or thrown away. */
  onDone: (result: { path: string | null; conflict: string | null }) => void
}

export function DraftCompare({ draftId, onClose, onDone }: Props) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState<DraftFull | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    showModalOnce(dialog.current)
    let alive = true
    draftsApi.one(draftId).then(
      (found) => alive && setDraft(found),
      (error) => alive && setProblem(error instanceof ApiError ? error.code : 'internal_error'),
    )
    return () => {
      alive = false
    }
  }, [draftId])

  const run = async (work: () => Promise<{ path: string | null; conflict: string | null }>) => {
    setBusy(true)
    setProblem(null)
    try {
      onDone(await work())
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby="draft-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
      className="m-auto h-[min(90vh,60rem)] w-[min(80rem,calc(100vw-2rem))] rounded-2xl border border-ink-700 bg-ink-950 p-0 text-mist-200 shadow-2xl backdrop:bg-scrim"
    >
      <div className="flex h-full flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-ink-700 px-5 py-3">
          <h2 id="draft-title" className="min-w-0 flex-1 text-base font-semibold text-mist-100">
            {draft ? t('drafts.compareTitle', { name: draft.key_name }) : t('common.loading')}
          </h2>
          <button type="button" onClick={onClose} disabled={busy} className="rounded-full px-3 py-1 text-sm text-mist-400 hover:bg-ink-850">
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={busy || !draft}
            onClick={() => void run(async () => {
              await draftsApi.discard(draftId)
              return { path: null, conflict: null }
            })}
            className="rounded-full border border-ink-700 px-3 py-1 text-sm text-bad-500 hover:bg-ink-850"
          >
            {t('drafts.discard')}
          </button>
          <button
            type="button"
            disabled={busy || !draft}
            onClick={() => void run(() => draftsApi.accept(draftId))}
            className="rounded-full bg-accent-500 px-3 py-1 text-sm font-semibold text-on-accent disabled:opacity-50"
          >
            {t('drafts.accept')}
          </button>
        </header>
        {draft?.reason && <p className="border-b border-ink-700/60 px-5 py-2 text-sm text-mist-300">„{draft.reason}“</p>}
        {draft?.changed && (
          <p role="note" className="border-b border-warn-500/30 bg-warn-500/10 px-5 py-2 text-sm text-warn-500">{t('drafts.changedSince')}</p>
        )}
        {problem && <p role="alert" className="border-b border-bad-500/30 bg-bad-500/10 px-5 py-2 text-sm text-bad-500">{errorText(problem)}</p>}
        <div className="grid grid-cols-2 gap-4 border-b border-ink-700/60 px-5 py-2 text-xs font-semibold text-mist-300">
          <div>{draft?.new ? t('drafts.nothingYet') : t('drafts.now')}</div>
          <div>{t('drafts.draft')}</div>
        </div>
        {draft && <CompareRows left={draft.current ?? ''} right={draft.content} testId="draft-rows" />}
      </div>
    </dialog>
  )
}
