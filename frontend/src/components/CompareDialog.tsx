/**
 * Two texts of a note side by side, the differences marked (the view of AI drafts and conflict copies): for "what
 * changed since your last visit" and for a proposal, with the proposal's answers as buttons.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { showModalOnce } from '../lib/dialog'
import { CompareRows } from './CompareRows'

type Props = {
  title: string
  left: { label: string; text: string }
  right: { label: string; text: string }
  /** A line above the texts (a proposal's message). */
  note?: string
  actions?: ReactNode
  problem?: string | null
  onClose: () => void
}

export function CompareDialog({ title, left, right, note, actions, problem, onClose }: Props) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => showModalOnce(dialog.current), [])
  return (
    <dialog
      ref={dialog}
      aria-labelledby="compare-dialog-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      className="m-auto h-[min(90vh,60rem)] w-[min(80rem,calc(100vw-2rem))] rounded-2xl border border-ink-700 bg-ink-950 p-0 text-mist-200 shadow-2xl backdrop:bg-scrim"
      data-testid="compare-dialog"
    >
      <div className="flex h-full flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-ink-700 px-5 py-3">
          <h2 id="compare-dialog-title" className="min-w-0 flex-1 text-base font-semibold text-mist-100">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-full px-3 py-1 text-sm text-mist-400 hover:bg-ink-850">
            {t('common.close')}
          </button>
          {actions}
        </header>
        {note && <p className="border-b border-ink-700/60 px-5 py-2 text-sm text-mist-300">„{note}“</p>}
        {problem && <p role="alert" className="border-b border-bad-500/30 bg-bad-500/10 px-5 py-2 text-sm text-bad-500">{problem}</p>}
        <div className="grid grid-cols-2 gap-4 border-b border-ink-700/60 px-5 py-2 text-xs font-semibold text-mist-300">
          <div>{left.label}</div>
          <div>{right.label}</div>
        </div>
        <CompareRows left={left.text} right={right.text} testId="compare-rows" />
      </div>
    </dialog>
  )
}
