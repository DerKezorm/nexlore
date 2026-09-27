/**
 * The notice while the vault is being read (the first start with a big vault, an import, many files changed from
 * outside). Signing in, reading and saving go on meanwhile; notes appear as they are read, so the notice says so
 * instead of leaving people to wonder where their notes are. The operator sees the counts, everybody else a share.
 * The store asks the server (`scan`).
 */
import { useTranslation } from 'react-i18next'

import { useStore } from '../state/store'

export function ScanNotice() {
  const { t } = useTranslation()
  const { scan } = useStore()
  if (!scan.running) return null
  const text =
    scan.done !== undefined && scan.total
      ? t('scan.counted', { done: scan.done.toLocaleString(), total: scan.total.toLocaleString() })
      : typeof scan.percent === 'number'
        ? t('scan.share', { percent: scan.percent })
        : t('scan.plain')
  return (
    <div className="shrink-0 border-b border-accent-500/30 bg-accent-500/10 px-4 py-2 text-sm" role="status" data-testid="scan-notice">
      <span className="font-medium text-accent-400">{text}</span>
      <span className="ml-2 text-mist-500">{t('scan.hint')}</span>
    </div>
  )
}
