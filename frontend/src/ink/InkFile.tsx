/**
 * The page of a drawing: the whole window is the endless surface, with the same toolbar as in a note, docked below.
 * The notes that use the drawing and the text the iPad recognised in it stand on the right. An SVG that is no
 * drawing shows the page every other file has (`fallback`).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { fileUrl, vaultApi, type Links } from '../api/client'
import { Sidebar } from '../components/Sidebar'
import { Symbol } from '../components/Symbol'
import { errorText } from '../lib/errors'
import { isCanvasPath } from '../lib/files'
import { bounds, fitTo, zoomAt, type Placement } from '../lib/ink'
import { fileRoute } from '../lib/markdown'
import { folderOf, noteUrl } from '../lib/vault'
import { ZoomBox } from './InkBlock'
import { InkSurface } from './InkSurface'
import { InkToolbar } from './InkToolbar'
import { inkKeys } from './keys'
import { useInk, useTools } from './useInk'

/** Room around the drawing when it is shown whole on the page. */
const PAGE_PAD = 70

/** Whether there is a step back inside the app: the router counts its own entries (`idx`), a page opened in a new tab
 * or from a bookmark starts at 0. */
const canGoBack = () => ((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0

/** `fallback`: the page of any other file, told why this one cannot be drawn in (null: it is no drawing at all). */
export default function InkFile({ path, fallback }: { path: string; fallback: (problem: string | null) => ReactNode }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const ink = useInk(path)
  const [tools, setTools] = useTools()
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [place, setPlace] = useState<Placement | null>(null)
  const [links, setLinks] = useState<Links | null>(null)
  const area = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    vaultApi.links(path).then((found) => alive && setLinks(found), () => undefined)
    return () => {
      alive = false
    }
  }, [path])

  const showAll = useCallback(() => {
    if (size.width) setPlace(fitTo(bounds(ink.strokes), size.width, size.height, PAGE_PAD))
  }, [ink.strokes, size])
  // The first view: everything, once the page knows its size and the drawing is there.
  const loaded = !!ink.loaded
  useEffect(() => {
    if (loaded && size.width && !place) showAll()
  }, [loaded, size.width, place, showAll])
  // Keys work from the start: the surface has the focus.
  useEffect(() => {
    if (loaded) area.current?.querySelector<HTMLElement>('[data-ink-surface]')?.focus({ preventScroll: true })
  }, [loaded])

  // Back where the drawing was opened from (a note's block, a canvas, the sidebar); a page opened from outside, with no
  // step back inside the app, goes to the first note that uses the drawing, else to the start.
  const leave = () => {
    if (canGoBack()) navigate(-1)
    else if (links?.backlinks.length) {
      const first = links.backlinks[0].path
      navigate(isCanvasPath(first) ? fileRoute(first) : noteUrl(first))
    } else navigate('/')
  }

  if (ink.status === 'ready' && !ink.loaded) return <>{fallback(ink.problem === 'not_ink' ? null : ink.problem)}</>
  const name = path.slice(path.lastIndexOf('/') + 1)
  // Escape first lets go of a choice made with the lasso, and only then leaves.
  const keys = inkKeys(ink, tools, setTools, { onShowAll: showAll, onEscape: leave })
  const recognised = typeof ink.loaded?.text === 'string' ? ink.loaded.text.trim() : ''

  return (
    <>
      <Sidebar activeNote={path} onNote={(next) => navigate(noteUrl(next))} />
      <main className="relative flex min-w-0 flex-1 flex-col" data-ink-page={path}>
        <header className="flex items-center gap-2 border-b border-ink-700 px-4 py-2">
          <button
            type="button"
            onClick={leave}
            title={t('ink.backHint')}
            data-ink-back=""
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-ink-700 py-1 pr-3 pl-2 text-xs text-mist-300 hover:bg-ink-850"
          >
            <Symbol name="chevronLeft" className="h-3.5 w-3.5" /> {t('ink.back')}
          </button>
          <Symbol name="draw" className="h-4 w-4 shrink-0 text-accent-400" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{name}</h1>
            <p className="truncate font-mono text-[11px] text-mist-500">{folderOf(path)}</p>
          </div>
          <span className="shrink-0 text-xs text-mist-500" aria-live="polite" data-ink-saved={ink.dirty ? 'saving' : 'saved'}>
            {ink.status !== 'ready' ? '' : ink.readonly ? t('ink.readOnly') : ink.dirty ? t('ink.saving') : t('ink.saved')}
          </span>
          <a
            href={fileUrl(path, true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-ink-700 px-3 py-1 text-xs text-mist-300 hover:bg-ink-850"
          >
            <Symbol name="download" className="h-3.5 w-3.5" /> {t('file.download')}
          </a>
        </header>
        {ink.conflict && (
          <p className="border-b border-warn-500/30 bg-warn-500/10 px-4 py-2 text-sm text-warn-500" role="status">
            {t('ink.conflict')}{' '}
            <button type="button" className="underline" onClick={() => navigate(fileRoute(ink.conflict!))}>
              {t('ink.showCopy')}
            </button>{' '}
            <button type="button" className="underline" onClick={ink.dismissConflict}>
              {t('common.close')}
            </button>
          </p>
        )}
        {ink.error && ink.status === 'ready' && (
          <p className="border-b border-bad-500/30 bg-bad-500/10 px-4 py-2 text-sm text-bad-500" role="alert">
            {errorText(ink.error)}
          </p>
        )}
        <div className="relative flex min-h-0 flex-1">
          {ink.status === 'failed' ? (
            <p className="m-auto text-sm text-bad-500" role="alert">
              {ink.error === 'not_found' ? t('file.notFound') : errorText(ink.error ?? 'internal_error')}
            </p>
          ) : ink.status === 'loading' ? (
            <p className="m-auto text-sm text-mist-500">{t('common.loading')}</p>
          ) : (
            <div ref={area} className="relative min-w-0 flex-1" onKeyDown={keys.onKeyDown} onKeyUp={keys.onKeyUp} onBlur={keys.onBlur}>
              <InkSurface
                ink={ink}
                tools={tools}
                place={place ?? { x: 0, y: 0, z: 1 }}
                onPlace={setPlace}
                moves
                draws
                onSize={(width, height) => setSize({ width, height })}
              >
                <ZoomBox
                  zoom={place?.z ?? 1}
                  onZoom={(factor) => place && setPlace(zoomAt(place, factor, size.width / 2, size.height / 2))}
                  onAll={showAll}
                  className="top-3 right-3"
                />
                <p className="pointer-events-none absolute bottom-20 left-3 hidden text-[11px] text-mist-500 md:block">{t('ink.pageHint')}</p>
              </InkSurface>
              <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-3">
                <InkToolbar ink={ink} tools={tools} setTools={setTools} up className="pointer-events-auto" />
              </div>
              {ink.lockedBy && (
                <p className="pointer-events-none absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded-xl border border-warn-500/40 bg-ink-900/95 px-4 py-2 text-sm text-warn-500 shadow-lg" role="status">
                  {t('ink.locked', { name: ink.lockedBy })}
                </p>
              )}
            </div>
          )}
          <aside className="hidden w-72 shrink-0 overflow-y-auto border-l border-ink-700 bg-ink-900 p-4 text-sm lg:block">
            <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-mist-500 uppercase">
              <Symbol name="backlink" className="h-3.5 w-3.5" /> {t('file.usedIn')}
            </h2>
            {links && links.backlinks.length === 0 && <p className="text-mist-500">{t('file.unused')}</p>}
            <ul className="mb-5">
              {links?.backlinks.map((item) => (
                <li key={item.path + item.line}>
                  <button
                    type="button"
                    onClick={() => navigate(isCanvasPath(item.path) ? fileRoute(item.path) : noteUrl(item.path))}
                    className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-ink-850"
                  >
                    <span className="block font-medium text-mist-200">{item.title}</span>
                    <span className="block truncate text-xs text-mist-500">{folderOf(item.path)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {recognised && (
              <>
                <h2 className="mb-2 text-xs font-semibold tracking-wide text-mist-500 uppercase">{t('ink.recognised')}</h2>
                <p className="rounded-lg border border-ink-700 p-2.5 whitespace-pre-wrap text-mist-300" data-ink-text="">
                  {recognised}
                </p>
              </>
            )}
            <p className="mt-5 text-xs text-mist-500">{t('ink.strokes', { count: ink.strokes.length })}</p>
          </aside>
        </div>
      </main>
    </>
  )
}
