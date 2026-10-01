/**
 * What belongs to a note beside it, in tabs: outline, links, the local graph, versions, and plugin panels when some
 * are on. On a wide screen a column (shown or hidden with the account); below 1280 pixels a sheet from the right on
 * request, on a phone from below. Escape and the dimmed page close a sheet.
 */
import { useEffect, useId, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import type { PanelTab } from '../lib/appearance'
import { Symbol } from './Symbol'

export type PanelPart = { id: PanelTab; label: string; count?: number | null; content: () => ReactNode }
export type PanelPlace = 'column' | 'sheet' | 'bottom'

type Props = {
  parts: PanelPart[]
  tab: PanelTab
  onTab: (tab: PanelTab) => void
  place: PanelPlace
  onClose: () => void
}

export function NotePanel({ parts, tab, onTab, place, onClose }: Props) {
  const { t } = useTranslation()
  const base = useId()
  // A tab that is not there (plugin panels switched off since) shows the links.
  const current = parts.find((part) => part.id === tab) ?? parts.find((part) => part.id === 'links') ?? parts[0]

  useEffect(() => {
    if (place === 'column') return
    const key = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [place, onClose])

  const frame =
    place === 'column'
      ? 'flex w-80 shrink-0 flex-col border-l border-ink-700/80'
      : place === 'sheet'
        ? 'fixed inset-y-0 right-0 z-40 flex w-[22rem] max-w-[90vw] flex-col border-l border-ink-700/80 bg-ink-950 shadow-2xl'
        : 'fixed inset-x-0 bottom-0 z-40 flex h-[78dvh] flex-col rounded-t-2xl border-t border-ink-700/80 bg-ink-950 pb-[env(safe-area-inset-bottom)] shadow-2xl'

  return (
    <>
      {place !== 'column' && <div aria-hidden="true" onClick={onClose} className="fixed inset-0 z-30 bg-scrim" data-testid="panel-scrim" />}
      <aside aria-label={t('panel.label')} className={frame} data-testid="note-panel" data-place={place}>
        {place === 'bottom' && <span aria-hidden="true" className="mx-auto mt-2 h-1 w-10 rounded-full bg-ink-600" />}
        {/* Wider than the column (six tabs and a plugin): they scroll in themselves, the app stays where it is (P7.3). */}
        <div className="nn-scroll flex shrink-0 items-end gap-0.5 overflow-x-auto overflow-y-hidden border-b border-ink-700/80 px-2 pt-2" role="tablist" aria-label={t('panel.label')}>
          {parts.map((part) => (
            <button
              key={part.id}
              type="button"
              role="tab"
              id={`${base}-${part.id}`}
              aria-selected={part.id === current.id}
              aria-controls={`${base}-body`}
              onClick={() => onTab(part.id)}
              className={
                '-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-2 pt-1.5 pb-2 text-[13px] whitespace-nowrap ' +
                (part.id === current.id ? 'border-accent-500 font-semibold text-mist-100' : 'border-transparent text-mist-500 hover:text-mist-200')
              }
            >
              {part.label}
              {part.count ? <span className="text-[11px] font-normal text-mist-600 tabular-nums">{part.count}</span> : null}
            </button>
          ))}
          {place !== 'column' && (
            <button type="button" onClick={onClose} aria-label={t('common.close')} title={t('common.close')} className="mb-1.5 ml-auto rounded-full p-1.5 text-mist-500 hover:bg-ink-850 hover:text-mist-100">
              <Symbol name="close" className="h-4 w-4" />
            </button>
          )}
        </div>
        <div id={`${base}-body`} role="tabpanel" aria-labelledby={`${base}-${current.id}`} className="nn-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {current.content()}
        </div>
      </aside>
    </>
  )
}
