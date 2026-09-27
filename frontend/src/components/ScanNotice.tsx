/**
 * The notice while the vault is being read (the first start with a big vault, an import, many files changed from
 * outside). Signing in, reading and saving go on meanwhile; notes appear as they are read, so the notice says so
 * instead of leaving people to wonder where their notes are. The operator sees the counts, everybody else a share.
 * Asks every 30 s, and every 2 s while a pass runs; when it ends, the spaces are loaded again.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { type IndexProgress, vaultApi } from '../api/client'
import { useStore } from '../state/store'

export const IDLE_MS = 30_000
export const RUNNING_MS = 2_000

export function ScanNotice() {
  const { t } = useTranslation()
  const { reload } = useStore()
  const [progress, setProgress] = useState<IndexProgress>({ running: false })
  const wasRunning = useRef(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let alive = true
    const ask = async () => {
      let running = false
      try {
        const answer = await vaultApi.progress()
        if (!alive) return
        running = answer.running
        setProgress(answer)
        if (wasRunning.current && !running) void reload()
        wasRunning.current = running
      } catch {
        // Not reachable or signed out: nothing to tell, the pages say what they need.
      }
      if (alive) timer = setTimeout(() => void ask(), running ? RUNNING_MS : IDLE_MS)
    }
    void ask()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [reload])

  if (!progress.running) return null
  const text =
    progress.done !== undefined && progress.total
      ? t('scan.counted', { done: progress.done.toLocaleString(), total: progress.total.toLocaleString() })
      : typeof progress.percent === 'number'
        ? t('scan.share', { percent: progress.percent })
        : t('scan.plain')
  return (
    <div className="shrink-0 border-b border-accent-500/30 bg-accent-500/10 px-4 py-2 text-sm" role="status" data-testid="scan-notice">
      <span className="font-medium text-accent-400">{text}</span>
      <span className="ml-2 text-mist-500">{t('scan.hint')}</span>
    </div>
  )
}
