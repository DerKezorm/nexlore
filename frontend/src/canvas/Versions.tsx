/**
 * The versions of a canvas, from its header: every save one (a session's saves folded together, old ones thinned
 * out, as for notes). An older one comes back after a question; the state before stays as a version of its own.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, vaultApi, type VersionInfo } from '../api/client'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Symbol } from '../components/Symbol'
import { useDialogFocus } from '../lib/dialogFocus'
import { errorText } from '../lib/errors'
import { formatDate } from '../lib/markdown'
import { usePeople } from '../lib/people'
import { versionSource } from '../lib/versions'

type Props = {
  path: string
  /** Not while it cannot be written (rights, somebody else editing, a file nexlore only shows). */
  disabled: boolean
  /** Save what waits first, so the version list holds it. */
  before: () => Promise<void>
  onRestored: () => void
}

export function CanvasVersions({ path, disabled, before, onRestored }: Props) {
  const { t } = useTranslation()
  const nameOf = usePeople()
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<VersionInfo[] | null>(null)
  const [asking, setAsking] = useState<VersionInfo | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  // The question on top has the keys while it is open.
  useDialogFocus(box, () => setOpen(false), () => asking !== null)

  useEffect(() => {
    if (!open) return
    let alive = true
    setList(null)
    setProblem(null)
    before()
      .then(() => vaultApi.versions(path))
      .then((found) => alive && setList(found))
      .catch((error: unknown) => alive && setProblem(error instanceof ApiError ? error.code : 'internal_error'))
    return () => {
      alive = false
    }
  }, [open, path, before])

  const restore = async (version: VersionInfo) => {
    setAsking(null)
    try {
      await vaultApi.restoreVersion(version.id)
      setOpen(false)
      onRestored()
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-full border border-ink-600 px-3 py-1 text-xs text-mist-300 hover:bg-ink-850"
      >
        <Symbol name="history" className="h-3.5 w-3.5" /> {t('note.versions')}
      </button>
      {open && (
        <div ref={box} role="dialog" aria-label={t('note.versions')} className="absolute right-0 top-full z-30 mt-1 w-80 rounded-xl border border-ink-600 bg-ink-850 p-2 shadow-2xl">
          {problem && (
            <p className="px-2 py-1 text-sm text-bad-500" role="alert">
              {errorText(problem)}
            </p>
          )}
          {list === null && !problem && <p className="px-2 py-1 text-sm text-mist-500">{t('common.loading')}</p>}
          <ul className="max-h-[60vh] space-y-0.5 overflow-y-auto">
            {list?.map((version, index) => (
              <li key={version.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-ink-800">
                <span className="min-w-0 flex-1">
                  <span className="block text-mist-300">{formatDate(version.updated_at)}</span>
                  <span className="block truncate text-[11px] text-mist-500">
                    {versionSource(version, t)}
                    {version.author ? ` · ${nameOf(version.author)}` : ''}
                  </span>
                </span>
                {index === 0 ? (
                  <span className="shrink-0 text-[11px] text-mist-500">{t('canvas.current')}</span>
                ) : (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setAsking(version)}
                    className="shrink-0 text-xs text-accent-400 hover:text-accent-300 disabled:opacity-40"
                  >
                    {t('note.restoreVersion')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ConfirmDialog
        open={asking !== null}
        title={t('canvas.restoreTitle')}
        confirm={t('note.restoreVersion')}
        onCancel={() => setAsking(null)}
        onConfirm={() => asking && void restore(asking)}
      >
        {asking ? t('canvas.restoreText', { when: formatDate(asking.updated_at) }) : ''}
      </ConfirmDialog>
    </div>
  )
}
