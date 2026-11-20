/**
 * A drawing in a note (`![[Sketch.svg]]`), in the reading view and in the editor. It shows the view kept with the
 * drawing (D9), else the whole drawing fitted to the note's width; "Show all" shows everything without keeping it.
 *
 * "Draw" turns the block into a window onto the endless drawing, with the pen's toolbar above it: Space, the right
 * or the middle button dragged, or the wheel move the picture, Ctrl with the wheel zooms, the edge below sets the
 * height. Saved a moment after each change; "Done" (or Escape) keeps the view and the height in the file.
 *
 * An SVG that is no drawing stays what it was: a link to the file.
 */
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { Symbol } from '../components/Symbol'
import { errorText } from '../lib/errors'
import { blockPlacement, bounds, changedView, fitTo, takeDrawRequest, zoomAt, type Placement } from '../lib/ink'
import { fileRoute } from '../lib/markdown'
import { InkSurface } from './InkSurface'
import { InkToolbar } from './InkToolbar'
import { inkKeys } from './keys'
import { draggedHeight } from './logic'
import { useInk, useTools } from './useInk'

type Shown = Placement & { h: number }

type Props = {
  path: string
  /** The link's words, for an SVG that is no drawing. */
  text: string
  /** Opens a page of the app (the drawing's own page). */
  onOpen: (route: string) => void
}

export default function InkBlock({ path, text, onOpen }: Props) {
  const { t } = useTranslation()
  const ink = useInk(path)
  const [tools, setTools] = useTools()
  const box = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [editing, setEditing] = useState(false)
  const [whole, setWhole] = useState(false)
  const [place, setPlace] = useState<Shown | null>(null)

  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const measure = () => setWidth(element.clientWidth)
    measure()
    const watcher = new ResizeObserver(measure)
    watcher.observe(element)
    return () => watcher.disconnect()
  }, [ink.loaded])

  const fitted = blockPlacement({ strokes: ink.strokes, view: ink.view }, width || 600, whole)
  const shown: Shown = editing && place ? place : fitted

  const start = () => {
    if (ink.readonly) return
    setPlace(fitted)
    setWhole(false)
    setEditing(true)
  }
  // Drawing begins with the keys on the surface, in the same render that shows it: a key pressed right after "Draw"
  // (E for the eraser) reaches it, where a timer could still be waiting under load.
  useLayoutEffect(() => {
    if (editing) surface.current?.querySelector<HTMLElement>('[data-ink-surface]')?.focus({ preventScroll: true })
  }, [editing])
  const done = () => {
    if (place) {
      const kept = changedView(ink.view, { x: place.x, y: place.y, z: place.z, h: place.h })
      if (kept) ink.keepView(kept)
    }
    ink.select([])
    setEditing(false)
    setPlace(null)
  }
  const showAll = () => {
    if (!editing || !place) return setWhole((now) => !now)
    setPlace({ ...fitTo(bounds(ink.strokes), width || 600, place.h), h: place.h })
  }

  // Made just now from the note: open for drawing at once.
  const ready = ink.status === 'ready' && !!ink.loaded && !ink.readonly
  useEffect(() => {
    if (!ready || !takeDrawRequest(path)) return
    start()
    box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    // Once, when it is ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, path])
  // Somebody else took it, or it turned out to be read only: drawing ends.
  useEffect(() => {
    if (editing && ink.readonly) setEditing(false)
  }, [editing, ink.readonly])

  const name = path.slice(path.lastIndexOf('/') + 1)
  const link = (
    <a
      className="nn-wikilink nn-filelink"
      data-file={path}
      href={fileRoute(path)}
      onClick={(event) => {
        if (event.ctrlKey || event.metaKey) return
        event.preventDefault()
        event.stopPropagation()
        onOpen(fileRoute(path))
      }}
    >
      {text}
    </a>
  )
  // Not known yet, or no drawing: the link, as before.
  if (ink.status === 'failed' || (ink.status === 'ready' && !ink.loaded)) return link
  if (ink.status === 'loading' || !ink.loaded) {
    return (
      <div className="nn-ink-block my-3 flex h-32 items-center justify-center rounded-xl border border-ink-700 text-sm text-mist-500" data-ink-block={path} data-loading="">
        {t('common.loading')}
      </div>
    )
  }

  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!place) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture?.(event.pointerId)
    const from = event.clientY
    const height = place.h
    const follow = (moving: PointerEvent) => setPlace((now) => (now ? { ...now, h: draggedHeight(height, moving.clientY - from) } : now))
    const stop = () => {
      handle.removeEventListener('pointermove', follow)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('pointercancel', stop)
    }
    handle.addEventListener('pointermove', follow)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }
  const keys = inkKeys(ink, tools, setTools, { onEscape: done, onShowAll: showAll })
  const zoom = (factor: number) => place && setPlace({ ...zoomAt(place, factor, (width || 600) / 2, place.h / 2), h: place.h })

  return (
    <div
      ref={box}
      className="nn-ink-block group relative my-3"
      data-ink-block={path}
      data-editing={editing ? '' : undefined}
      onKeyDown={editing ? keys.onKeyDown : undefined}
      onKeyUp={editing ? keys.onKeyUp : undefined}
      onBlur={editing ? keys.onBlur : undefined}
    >
      {editing && (
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <InkToolbar ink={ink} tools={tools} setTools={setTools} onDone={done} />
          <span className="text-xs text-mist-500" aria-live="polite" data-ink-saved={ink.dirty ? 'saving' : 'saved'}>
            {ink.dirty ? t('ink.saving') : t('ink.saved')}
          </span>
        </div>
      )}
      {ink.conflict && (
        <div className="mb-1.5 rounded-lg border border-warn-500/30 bg-warn-500/10 px-3 py-1.5 text-sm text-warn-500" role="status">
          {t('ink.conflict')}{' '}
          <button type="button" className="underline" onClick={() => onOpen(fileRoute(ink.conflict!))}>
            {t('ink.showCopy')}
          </button>{' '}
          <button type="button" className="underline" onClick={ink.dismissConflict}>
            {t('common.close')}
          </button>
        </div>
      )}
      {ink.lockedBy && (
        <div className="mb-1.5 rounded-lg border border-warn-500/30 bg-warn-500/10 px-3 py-1.5 text-sm text-warn-500" role="status">
          {t('ink.locked', { name: ink.lockedBy })}
        </div>
      )}
      {ink.error && (
        <div className="mb-1.5 rounded-lg border border-bad-500/30 bg-bad-500/10 px-3 py-1.5 text-sm text-bad-500" role="alert">
          {errorText(ink.error)}
        </div>
      )}
      <div
        ref={surface}
        className={
          'relative overflow-hidden rounded-xl border ' +
          (editing ? 'border-accent-500 shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-accent-500)_14%,transparent)]' : 'border-ink-700/60 group-hover:border-ink-700')
        }
      >
        <InkSurface
          ink={ink}
          tools={tools}
          place={shown}
          onPlace={(next) => setPlace((now) => ({ ...next, h: now?.h ?? shown.h }))}
          moves={editing}
          draws={editing}
          height={shown.h}
        >
          {!editing && ink.strokes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-mist-500">{t('ink.empty')}</div>
          )}
          {!editing && (
            <>
              <span className="pointer-events-none absolute top-2 left-2.5 hidden max-w-[60%] truncate rounded-md border border-ink-700 bg-ink-900 px-1.5 text-[11px] text-mist-500 group-focus-within:block group-hover:block pointer-coarse:block">
                {name}
              </span>
              <div className="absolute top-2 right-2 hidden gap-0.5 rounded-lg border border-ink-600 bg-ink-850 p-0.5 shadow-lg group-focus-within:flex group-hover:flex pointer-coarse:flex">
                {!ink.readonly && (
                  <button type="button" data-ink-act="draw" onClick={start} className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-mist-300 hover:bg-ink-700 hover:text-mist-100">
                    <Symbol name="pencil" className="h-3.5 w-3.5" /> {t('ink.draw')}
                  </button>
                )}
                <button type="button" data-ink-act="open" onClick={() => onOpen(fileRoute(path))} className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-mist-300 hover:bg-ink-700 hover:text-mist-100">
                  <Symbol name="fit" className="h-3.5 w-3.5" /> {t('ink.openLarge')}
                </button>
              </div>
              {ink.view && ink.strokes.length > 0 && (
                <button
                  type="button"
                  data-ink-act="whole"
                  aria-pressed={whole}
                  onClick={() => setWhole((now) => !now)}
                  className="absolute right-2 bottom-2 hidden rounded-lg border border-ink-600 bg-ink-850 px-2 py-0.5 text-xs text-mist-300 hover:bg-ink-700 group-focus-within:block group-hover:block pointer-coarse:block"
                >
                  {whole ? t('ink.showKept') : t('ink.showAll')}
                </button>
              )}
            </>
          )}
          {editing && (
            <>
              <div className="pointer-events-none absolute bottom-2 left-2.5 hidden text-[11px] text-mist-500 sm:block">{t('ink.moveHint')}</div>
              <ZoomBox zoom={shown.z} onZoom={zoom} onAll={showAll} />
            </>
          )}
        </InkSurface>
      </div>
      {editing && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('ink.height')}
          title={t('ink.height')}
          data-ink-height={shown.h}
          onPointerDown={resize}
          className="flex h-3 cursor-ns-resize touch-none items-center justify-center before:h-1 before:w-12 before:rounded-full before:bg-ink-600 hover:before:bg-accent-500"
        />
      )}
    </div>
  )
}

/** Smaller, larger, how close, and everything at once. */
export function ZoomBox({ zoom, onZoom, onAll, className = 'right-2 bottom-2' }: { zoom: number; onZoom: (factor: number) => void; onAll: () => void; className?: string }) {
  const { t } = useTranslation()
  const small = 'inline-flex h-6 min-w-6 items-center justify-center rounded-md px-1.5 text-xs text-mist-300 hover:bg-ink-700'
  return (
    <div className={'absolute flex items-center gap-0.5 rounded-lg border border-ink-600 bg-ink-850 p-0.5 text-xs text-mist-400 ' + className} onPointerDown={(event) => event.stopPropagation()}>
      <button type="button" className={small} aria-label={t('ink.zoomOut')} title={t('ink.zoomOut')} onClick={() => onZoom(0.8)}>
        <Symbol name="minus" className="h-3.5 w-3.5" />
      </button>
      <span className="min-w-10 text-center tabular-nums" data-ink-zoom="">
        {Math.round(zoom * 100)} %
      </span>
      <button type="button" className={small} aria-label={t('ink.zoomIn')} title={t('ink.zoomIn')} onClick={() => onZoom(1.25)}>
        <Symbol name="plus" className="h-3.5 w-3.5" />
      </button>
      <button type="button" className={small} data-ink-act="fit" onClick={onAll} title={t('ink.showAllKey')}>
        {t('ink.showAll')}
      </button>
    </div>
  )
}
