/**
 * Merging a note into another (Obsidian's note composer): the other one is found by its name in the same space; the
 * dialog says what happens (the text goes to its end, links follow, this note goes into the trash) before it does.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, vaultApi, type Found } from '../api/client'
import { errorText } from '../lib/errors'
import { baseName } from '../lib/vault'
import { Symbol } from './Symbol'

const title = (path: string) => baseName(path).replace(/\.md$/i, '')

export function MergeDialog({ source, onDone, onClose }: { source: string; onDone: (target: string) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const space = source.split('/')[0]
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<Found[]>([])
  const [target, setTarget] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    dialog.current?.showModal()
    field.current?.focus()
  }, [])

  useEffect(() => {
    let live = true
    const timer = window.setTimeout(() => {
      vaultApi.find(query.trim(), space, 20).then(
        (hits) => live && setFound(hits.filter((hit) => hit.path !== source && hit.path.startsWith(space + '/')).slice(0, 12)),
        () => live && setFound([]),
      )
    }, 150)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [query, space, source])

  const merge = async () => {
    if (!target) return
    setBusy(true)
    setProblem(null)
    try {
      await vaultApi.merge(source, target)
      onDone(target)
    } catch (error) {
      setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
      onClick={(event) => event.target === dialog.current && !busy && onClose()}
      className="m-auto w-[min(30rem,calc(100vw-2rem))] rounded-2xl border border-ink-700 bg-ink-900 p-0 text-mist-200 shadow-2xl backdrop:bg-scrim"
      data-testid="merge-dialog"
    >
      <div className="p-5">
        <h2 id={titleId} className="text-base font-semibold text-mist-100">{t('merge.title', { name: title(source) })}</h2>
        {target ? (
          <>
            <p className="mt-3 text-sm text-mist-300" data-testid="merge-explain">{t('merge.explain', { name: title(source), target: title(target) })}</p>
            {problem && <p className="mt-2 text-sm text-bad-400">{problem}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" disabled={busy} onClick={onClose} className="rounded-full px-4 py-1.5 text-sm text-mist-300 hover:bg-ink-850">
                {t('common.cancel')}
              </button>
              <button type="button" disabled={busy} onClick={() => setTarget(null)} className="rounded-full px-4 py-1.5 text-sm text-mist-300 hover:bg-ink-850">
                {t('merge.back')}
              </button>
              <button type="button" disabled={busy} onClick={() => void merge()} className="rounded-full bg-accent-500 px-4 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-50">
                {t('merge.do')}
              </button>
            </div>
          </>
        ) : (
          <>
            <input
              ref={field}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('merge.search')}
              aria-label={t('merge.search')}
              className="mt-3 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-1.5 text-sm text-mist-100 outline-none focus:border-accent-500"
            />
            <ul className="nn-scroll mt-2 max-h-72 overflow-y-auto" role="listbox" aria-label={t('merge.search')}>
              {found.map((hit) => (
                <li key={hit.path}>
                  <button type="button" onClick={() => setTarget(hit.path)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-ink-850" role="option" aria-selected={false}>
                    <Symbol name="note" className="h-3.5 w-3.5 shrink-0 text-mist-600" />
                    <span className="min-w-0 flex-1 truncate">{hit.title || title(hit.path)}</span>
                    <span className="shrink-0 truncate text-xs text-mist-600">{hit.path.split('/').slice(1, -1).join(' › ')}</span>
                  </button>
                </li>
              ))}
              {found.length === 0 && <li className="px-2 py-3 text-sm text-mist-500">{t('merge.nothing')}</li>}
            </ul>
            <div className="mt-4 flex justify-end">
              <button type="button" onClick={onClose} className="rounded-full px-4 py-1.5 text-sm text-mist-300 hover:bg-ink-850">
                {t('common.cancel')}
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
  )
}
