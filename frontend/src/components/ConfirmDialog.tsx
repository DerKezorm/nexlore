/**
 * nexlore's own question before something goes, instead of the browser's `confirm`: the `ConfirmDialog` of the ui kit
 * (plan "Einstellungen", E31: the windows of the settings, and the same window wherever else it opens). Focus stays
 * inside, Escape and a click beside it cancel; "Cancel" and the button that does it, red where something goes.
 */
import { AlertTriangle, Check, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog as KitConfirmDialog } from '../vendor/nexui'

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
  if (!open) return null
  return (
    <KitConfirmDialog
      title={title}
      confirm={{ label: confirm, kind: danger ? 'danger' : 'primary', icon: danger ? Trash2 : Check }}
      cancel={t('common.cancel')}
      closeLabel={t('common.close')}
      busy={busy}
      onConfirm={() => {
        if (!busy) onConfirm()
      }}
      onCancel={() => {
        if (!busy) onCancel()
      }}
      testId="confirm-dialog"
    >
      {children && (
        <div className="flex gap-2 text-sm text-[var(--nexui-text)]">
          <AlertTriangle aria-hidden className={'mt-0.5 h-4 w-4 shrink-0 ' + (danger ? 'text-[var(--nexui-danger)]' : 'text-[var(--nexui-warn)]')} />
          <div className="min-w-0">{children}</div>
        </div>
      )}
    </KitConfirmDialog>
  )
}
