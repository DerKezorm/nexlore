/**
 * nexlore's own question before something goes, instead of the browser's `confirm`: a modal `<dialog>` (focus stays
 * inside, Escape cancels), the safe choice focused first.
 */
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Symbol } from './Symbol'

type Props = {
  open: boolean
  title: string
  children?: ReactNode
  /** Text of the button that does it. */
  confirm: string
  /** Red button: the step cannot be undone. */
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ open, title, children, confirm, danger = false, busy = false, onConfirm, onCancel }: Props) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  // Its own id: two dialogs on one page must not both be named by the first one's title.
  const titleId = useId()

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) {
      element.showModal()
      cancel.current?.focus()
    } else if (!open && element.open) element.close()
  }, [open])

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onCancel()
      }}
      onClick={(event) => {
        // A click on the backdrop (the dialog element itself, outside its box) cancels.
        if (event.target === dialog.current && !busy) onCancel()
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-2xl border border-ink-700 bg-ink-900 p-0 text-mist-200 shadow-2xl backdrop:bg-scrim"
    >
      <div className="p-5">
        <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold text-mist-100">
          <Symbol name="alert" className={'h-4 w-4 ' + (danger ? 'text-bad-500' : 'text-warn-500')} />
          {title}
        </h2>
        {children && <div className="mt-2 text-sm text-mist-400">{children}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <button ref={cancel} type="button" disabled={busy} onClick={onCancel} className="rounded-full px-4 py-1.5 text-sm text-mist-300 hover:bg-ink-850">
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={
              'rounded-full px-4 py-1.5 text-sm font-semibold disabled:opacity-50 ' +
              (danger ? 'bg-bad-500 text-white hover:opacity-90' : 'bg-accent-500 text-on-accent hover:bg-accent-400')
            }
          >
            {confirm}
          </button>
        </div>
      </div>
    </dialog>
  )
}
