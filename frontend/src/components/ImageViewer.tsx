/**
 * A picture of the note over the whole page, at its own size or fitted to the screen, to zoom into and move around:
 * the mouse wheel and two fingers zoom where they are, dragging moves, a double click switches between fitted and
 * real size. The arrows go through the note's other pictures; the strip below shows them all, to mark some and save
 * the marked ones together (several as one ZIP). Escape closes.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError } from '../api/client'
import { errorText } from '../lib/errors'
import { downloadPictures, type Picture } from '../lib/pictures'
import { Symbol } from './Symbol'

const MIN_SCALE = 0.05
const MAX_SCALE = 16
const STEP = 1.25

type View = { scale: number; x: number; y: number }

type Props = {
  pictures: Picture[]
  start: number
  /** The archive's name when several are saved (the note's name). */
  archive: string
  onClose: () => void
}

export function ImageViewer({ pictures, start, archive, onClose }: Props) {
  const { t } = useTranslation()
  const [index, setIndex] = useState(start)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [stage, setStage] = useState<{ w: number; h: number }>({ w: window.innerWidth, h: window.innerHeight })
  const [view, setView] = useState<View | null>(null)
  const [marked, setMarked] = useState<Set<number>>(new Set())
  const [problem, setProblem] = useState<string | null>(null)
  const area = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ distance: number; view: View } | null>(null)
  const picture = pictures[index]

  // The stage's size follows the window.
  useEffect(() => {
    const element = area.current
    if (!element) return
    const measure = () => setStage({ w: element.clientWidth, h: element.clientHeight })
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(element)
    return () => watch.disconnect()
  }, [])

  // The focus comes in, and goes back where it was when the viewer closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    closeButton.current?.focus()
    return () => before?.focus?.()
  }, [])

  const fitScale = (size = natural) => (size ? Math.min(1, (stage.w - 32) / size.w, (stage.h - 32) / size.h) : 1)
  const centered = (scale: number, size = natural): View =>
    size ? { scale, x: (stage.w - size.w * scale) / 2, y: (stage.h - size.h * scale) / 2 } : { scale, x: 0, y: 0 }

  /** Zoom to `scale` keeping the point (`px`, `py`) of the stage where it is. */
  const zoomAt = (scale: number, px = stage.w / 2, py = stage.h / 2) =>
    setView((was) => {
      if (!was) return was
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
      return { scale: next, x: px - ((px - was.x) * next) / was.scale, y: py - ((py - was.y) * next) / was.scale }
    })
  const fit = () => setView(centered(fitScale()))
  const actual = () => setView(centered(1))

  const go = (to: number) => {
    const next = (to + pictures.length) % pictures.length
    if (next === index) return
    setIndex(next)
    setNatural(null)
    setView(null)
  }

  const toggleMark = (at: number) =>
    setMarked((was) => {
      const next = new Set(was)
      if (next.has(at)) next.delete(at)
      else next.add(at)
      return next
    })

  const save = async (which: Picture[]) => {
    setProblem(null)
    try {
      await downloadPictures(which, archive)
    } catch (error) {
      setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
    }
  }

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowRight') go(index + 1)
      else if (event.key === 'ArrowLeft') go(index - 1)
      else if (event.key === '+' || event.key === '=') zoomAt((view?.scale ?? 1) * STEP)
      else if (event.key === '-') zoomAt((view?.scale ?? 1) / STEP)
      else if (event.key === '0') fit()
      else if (event.key === '1') actual()
      else if (event.key.toLowerCase() === 'm' && pictures.length > 1) toggleMark(index)
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  })

  // The wheel zooms where the mouse is (a listener of its own: React's wheel handlers cannot stop the page scrolling).
  useEffect(() => {
    const element = area.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const box = element.getBoundingClientRect()
      setView((was) => {
        if (!was) return was
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, was.scale * Math.pow(1.0015, -event.deltaY)))
        const px = event.clientX - box.left
        const py = event.clientY - box.top
        return { scale: next, x: px - ((px - was.x) * next) / was.scale, y: py - ((py - was.y) * next) / was.scale }
      })
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [])

  const down = (event: ReactPointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.current.size === 2 && view) {
      const [a, b] = [...pointers.current.values()]
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), view }
    }
  }
  const move = (event: ReactPointerEvent) => {
    const last = pointers.current.get(event.pointerId)
    if (!last) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.current.size === 2 && pinch.current) {
      // Two fingers: zoom around the point between them.
      const [a, b] = [...pointers.current.values()]
      const box = area.current!.getBoundingClientRect()
      const px = (a.x + b.x) / 2 - box.left
      const py = (a.y + b.y) / 2 - box.top
      const from = pinch.current.view
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (from.scale * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.current.distance))
      setView({ scale: next, x: px - ((px - from.x) * next) / from.scale, y: py - ((py - from.y) * next) / from.scale })
      return
    }
    setView((was) => was && { ...was, x: was.x + event.clientX - last.x, y: was.y + event.clientY - last.y })
  }
  const up = (event: ReactPointerEvent) => {
    pointers.current.delete(event.pointerId)
    if (pointers.current.size < 2) pinch.current = null
  }

  const percent = view ? Math.round(view.scale * 100) : null
  const tool = 'inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-lg px-2 text-sm text-mist-200 hover:bg-white/10 disabled:opacity-40'
  const inVault = (items: Picture[]) => items.filter((item) => item.path)
  const markedPictures = [...marked].sort((a, b) => a - b).map((at) => pictures[at])

  return (
    <div role="dialog" aria-modal="true" aria-label={t('viewer.title')} data-testid="image-viewer" className="fixed inset-0 z-50 flex flex-col bg-black/90 text-mist-100">
      <div className="flex flex-wrap items-center gap-1 px-3 py-2" style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}>
        <span className="mr-2 min-w-0 flex-1 truncate text-sm" title={picture.path ?? picture.src}>
          {picture.name}
          {pictures.length > 1 && <span className="ml-2 text-mist-400 tabular-nums">{t('viewer.position', { at: index + 1, of: pictures.length })}</span>}
        </span>
        <button type="button" className={tool} aria-label={t('viewer.zoomOut')} title={`${t('viewer.zoomOut')} (-)`} onClick={() => zoomAt((view?.scale ?? 1) / STEP)}>
          <Symbol name="minus" className="h-4 w-4" />
        </button>
        <button type="button" className={tool + ' w-16 tabular-nums'} aria-label={t('viewer.actual')} title={`${t('viewer.actual')} (1)`} onClick={actual} data-testid="viewer-zoom">
          {percent === null ? '' : `${percent} %`}
        </button>
        <button type="button" className={tool} aria-label={t('viewer.zoomIn')} title={`${t('viewer.zoomIn')} (+)`} onClick={() => zoomAt((view?.scale ?? 1) * STEP)}>
          <Symbol name="plus" className="h-4 w-4" />
        </button>
        <button type="button" className={tool} aria-label={t('viewer.fit')} title={`${t('viewer.fit')} (0)`} onClick={fit}>
          <Symbol name="fit" className="h-4 w-4" />
        </button>
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-white/20" />
        {/* Marking gathers several pictures for one download: with one picture there is nothing to gather. */}
        {pictures.length > 1 && (
          <button type="button" className={tool} aria-pressed={marked.has(index)} title={`${t('viewer.mark')} (M)`} onClick={() => toggleMark(index)}>
            <Symbol name="check" className={'h-4 w-4 ' + (marked.has(index) ? 'text-accent-400' : 'opacity-50')} />
            <span className="hidden sm:inline">{t('viewer.mark')}</span>
          </button>
        )}
        <button type="button" className={tool} disabled={!picture.path} title={picture.path ? t('viewer.download') : t('viewer.fromWeb')} onClick={() => void save([picture])}>
          <Symbol name="download" className="h-4 w-4" />
          <span className="hidden sm:inline">{t('viewer.download')}</span>
        </button>
        {pictures.length > 1 && (
          <button type="button" className={tool} disabled={!inVault(markedPictures).length} onClick={() => void save(markedPictures)}>
            {t('viewer.downloadMarked', { count: inVault(markedPictures).length })}
          </button>
        )}
        <button ref={closeButton} type="button" className={tool} aria-label={t('viewer.close')} title={`${t('viewer.close')} (Esc)`} onClick={onClose}>
          <Symbol name="close" className="h-4 w-4" />
        </button>
      </div>
      {problem && (
        <p role="alert" className="px-4 pb-2 text-sm text-warn-500">
          {problem}
        </p>
      )}
      <div
        ref={area}
        className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden select-none active:cursor-grabbing"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onDoubleClick={(event) => {
          const box = area.current!.getBoundingClientRect()
          if (view && Math.abs(view.scale - fitScale()) < 0.01 && fitScale() < 1) zoomAt(1, event.clientX - box.left, event.clientY - box.top)
          else if (view && Math.abs(view.scale - 1) < 0.01 && fitScale() >= 1) zoomAt(2, event.clientX - box.left, event.clientY - box.top)
          else fit()
        }}
      >
        <img
          key={picture.src}
          src={picture.src}
          alt={picture.name}
          draggable={false}
          data-testid="viewer-image"
          onLoad={(event) => {
            const size = { w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight }
            setNatural(size)
            setView(centered(fitScale(size), size))
          }}
          style={
            view && natural
              ? { width: natural.w, height: natural.h, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: '0 0', imageRendering: view.scale >= 3 ? 'pixelated' : undefined }
              : { opacity: 0 }
          }
          className="absolute top-0 left-0 max-w-none"
        />
        {pictures.length > 1 && (
          <>
            <button type="button" aria-label={t('viewer.previous')} onClick={() => go(index - 1)} onPointerDown={(event) => event.stopPropagation()} className="absolute top-1/2 left-2 -translate-y-1/2 rounded-full bg-black/50 p-2 hover:bg-black/70">
              <Symbol name="chevronLeft" className="h-6 w-6" />
            </button>
            <button type="button" aria-label={t('viewer.next')} onClick={() => go(index + 1)} onPointerDown={(event) => event.stopPropagation()} className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full bg-black/50 p-2 hover:bg-black/70">
              <Symbol name="chevronRight" className="h-6 w-6" />
            </button>
          </>
        )}
      </div>
      {pictures.length > 1 && (
        <ul className="flex gap-2 overflow-x-auto px-3 py-2" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }} aria-label={t('viewer.all')}>
          {pictures.map((item, at) => (
            <li key={item.src + at} className="relative shrink-0">
              <button
                type="button"
                onClick={() => go(at)}
                aria-current={at === index || undefined}
                aria-label={item.name}
                className={'block h-14 w-20 overflow-hidden rounded-md border-2 bg-black ' + (at === index ? 'border-accent-400' : 'border-transparent opacity-70 hover:opacity-100')}
              >
                <img src={item.src} alt="" className="h-full w-full object-contain" draggable={false} />
              </button>
              <button
                type="button"
                aria-pressed={marked.has(at)}
                aria-label={t('viewer.markThis', { name: item.name })}
                onClick={() => toggleMark(at)}
                className={'absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded border ' + (marked.has(at) ? 'border-accent-400 bg-accent-500 text-on-accent' : 'border-white/60 bg-black/60')}
              >
                {marked.has(at) && <Symbol name="check" className="h-3.5 w-3.5" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
