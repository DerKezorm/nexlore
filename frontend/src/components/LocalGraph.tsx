/**
 * The neighbourhood of one note on its page: every note up to one, two or three links away (either direction), the
 * note itself in the middle. A few dozen dots, so a small force layout in the browser and a 2D canvas are enough.
 *
 * Drag moves, the wheel or two fingers zoom, a click on a dot opens that note. The depth is kept per browser.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { graphApi, type LocalNode } from '../api/client'
import { drawLabels, type LabelItem } from '../graph/labels'
import { layoutLocal, type Dot } from '../graph/local'
import { folderColor } from '../graph/palette'
import { THEME_EVENT } from '../lib/theme'
import { Symbol } from './Symbol'

const DEPTH_KEY = 'nexlore.local.depth'
const LIMIT = 150

type Camera = { x: number; y: number; k: number }

function storedDepth(): number {
  try {
    const value = Number(localStorage.getItem(DEPTH_KEY))
    return value === 2 || value === 3 ? value : 1
  } catch {
    return 1
  }
}

export function LocalGraph({ path, generation, onOpen, onShowInGraph }: { path: string; generation: number; onOpen: (path: string) => void; onShowInGraph: () => void }) {
  const { t } = useTranslation()
  const [depth, setDepth] = useState(storedDepth)
  const [data, setData] = useState<{ nodes: LocalNode[]; links: [number, number][] } | null>(null)
  const [failed, setFailed] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null)
  const camera = useRef<Camera>({ x: 0, y: 0, k: 1 })
  const hover = useRef<number | null>(null)
  const frame = useRef(0)
  const drawRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    let live = true
    setFailed(false)
    graphApi.local(path, depth, LIMIT).then(
      (found) => live && setData(found),
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [path, depth, generation])

  const dots = useMemo(() => (data ? layoutLocal(data.nodes, data.links) : []), [data])
  const byId = useMemo(() => new Map(dots.map((dot) => [dot.id, dot])), [dots])

  const chooseDepth = (next: number) => {
    setDepth(next)
    try {
      localStorage.setItem(DEPTH_KEY, String(next))
    } catch {
      // Then it holds for this page only.
    }
  }

  // Fit everything in view whenever new dots arrive.
  useEffect(() => {
    const element = canvas.current
    if (!element || !dots.length) return
    let extent = 60
    for (const dot of dots) extent = Math.max(extent, Math.abs(dot.x!) + 40, Math.abs(dot.y!) + 30)
    const rect = element.getBoundingClientRect()
    camera.current = { x: 0, y: 0, k: Math.min(2, Math.min(rect.width, rect.height) / 2 / extent) }
    drawRef.current()
  }, [dots])

  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const draw = () => {
      frame.current = 0
      const rect = element.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      if (element.width !== Math.round(rect.width * dpr) || element.height !== Math.round(rect.height * dpr)) {
        element.width = Math.round(rect.width * dpr)
        element.height = Math.round(rect.height * dpr)
      }
      const ctx = element.getContext('2d')
      if (!ctx) return
      const style = getComputedStyle(document.documentElement)
      const color = (name: string) => style.getPropertyValue(name).trim() || '#888888'
      const { x: cx, y: cy, k } = camera.current
      const w = rect.width
      const h = rect.height
      const sx = (x: number) => (x - cx) * k + w / 2
      const sy = (y: number) => (y - cy) * k + h / 2
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const focus = hover.current
      ctx.lineWidth = 1
      for (const [a, b] of data?.links ?? []) {
        const from = byId.get(a)
        const to = byId.get(b)
        if (!from || !to) continue
        const hot = focus !== null && (a === focus || b === focus)
        ctx.strokeStyle = hot ? color('--color-accent-500') : color('--color-mist-500') + (focus !== null ? '22' : '55')
        ctx.lineWidth = hot ? 1.8 : 1
        ctx.beginPath()
        ctx.moveTo(sx(from.x!), sy(from.y!))
        ctx.lineTo(sx(to.x!), sy(to.y!))
        ctx.stroke()
      }
      const labels: LabelItem[] = []
      for (const dot of dots) {
        const r = dot.depth === 0 ? 7 : Math.max(3, 5.5 - dot.depth)
        const x = sx(dot.x!)
        const y = sy(dot.y!)
        ctx.globalAlpha = dot.depth > 1 && focus !== dot.id ? 0.6 : 1
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fillStyle = dot.depth === 0 || dot.id === focus ? color('--color-accent-500') : folderColor(dot.path)
        ctx.fill()
        ctx.globalAlpha = 1
        labels.push({
          x, y: y + r + 4, text: dot.title, size: dot.depth === 0 ? 12 : 11, weight: dot.depth === 0 ? 600 : 500,
          color: dot.depth === 0 ? color('--color-accent-400') : color('--color-mist-300'), alpha: dot.depth > 1 && dot.id !== focus ? 0.7 : 1,
          baseline: 'top', priority: dot.id === focus ? 1000 : dot.depth === 0 ? 900 : 100 - dot.depth * 10, halo: true,
        })
      }
      drawLabels(ctx, labels, color('--color-ink-900'), w, h)
    }
    drawRef.current = () => {
      if (!frame.current) frame.current = requestAnimationFrame(draw)
    }
    drawRef.current()

    const pointers = new Map<number, { x: number; y: number }>()
    let moved = 0
    let pinch: { distance: number; k: number } | null = null
    const local = (event: PointerEvent | WheelEvent) => {
      const rect = element.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }
    const hitAt = (px: number, py: number): Dot | null => {
      const rect = element.getBoundingClientRect()
      const { x: cx, y: cy, k } = camera.current
      let best: Dot | null = null
      let distance = 14
      for (const dot of dots) {
        const d = Math.hypot((dot.x! - cx) * k + rect.width / 2 - px, (dot.y! - cy) * k + rect.height / 2 - py)
        if (d < distance) {
          distance = d
          best = dot
        }
      }
      return best
    }
    const zoomAt = (px: number, py: number, factor: number) => {
      const rect = element.getBoundingClientRect()
      const c = camera.current
      const k = Math.min(6, Math.max(0.2, c.k * factor))
      const wx = (px - rect.width / 2) / c.k + c.x
      const wy = (py - rect.height / 2) / c.k + c.y
      camera.current = { k, x: wx - (px - rect.width / 2) / k, y: wy - (py - rect.height / 2) / k }
      drawRef.current()
    }
    const onDown = (event: PointerEvent) => {
      try {
        element.setPointerCapture(event.pointerId)
      } catch {
        // A pointer the browser no longer knows (lifted in between): the gesture works without the capture.
      }
      pointers.set(event.pointerId, local(event))
      moved = 0
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), k: camera.current.k }
      }
    }
    const onMove = (event: PointerEvent) => {
      const p = local(event)
      const previous = pointers.get(event.pointerId)
      if (!previous) {
        const hit = hitAt(p.x, p.y)?.id ?? null
        if (hit !== hover.current) {
          hover.current = hit
          element.style.cursor = hit !== null ? 'pointer' : 'grab'
          drawRef.current()
        }
        return
      }
      pointers.set(event.pointerId, p)
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()]
        zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, (pinch.k * (Math.hypot(a.x - b.x, a.y - b.y) / Math.max(pinch.distance, 1))) / camera.current.k)
        moved += 10
        return
      }
      moved += Math.abs(p.x - previous.x) + Math.abs(p.y - previous.y)
      if (moved > 3) {
        const c = camera.current
        camera.current = { ...c, x: c.x - (p.x - previous.x) / c.k, y: c.y - (p.y - previous.y) / c.k }
        drawRef.current()
      }
    }
    const onUp = (event: PointerEvent) => {
      const p = local(event)
      pointers.delete(event.pointerId)
      if (pointers.size < 2) pinch = null
      if (moved > 3 || pointers.size > 0 || event.type === 'pointercancel') return
      const hit = hitAt(p.x, p.y)
      if (hit && hit.depth > 0) onOpen(hit.path)
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const p = local(event)
      zoomAt(p.x, p.y, Math.exp(-event.deltaY * 0.0016))
    }
    const onLeave = () => {
      if (hover.current !== null && pointers.size === 0) {
        hover.current = null
        drawRef.current()
      }
    }
    const observer = new ResizeObserver(() => drawRef.current())
    observer.observe(element)
    window.addEventListener(THEME_EVENT, drawRef.current)
    element.addEventListener('pointerdown', onDown)
    element.addEventListener('pointermove', onMove)
    element.addEventListener('pointerup', onUp)
    element.addEventListener('pointercancel', onUp)
    element.addEventListener('pointerleave', onLeave)
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      cancelAnimationFrame(frame.current)
      frame.current = 0
      observer.disconnect()
      window.removeEventListener(THEME_EVENT, drawRef.current)
      element.removeEventListener('pointerdown', onDown)
      element.removeEventListener('pointermove', onMove)
      element.removeEventListener('pointerup', onUp)
      element.removeEventListener('pointercancel', onUp)
      element.removeEventListener('pointerleave', onLeave)
      element.removeEventListener('wheel', onWheel)
    }
  }, [dots, byId, data, onOpen])

  const alone = data !== null && data.nodes.length <= 1
  return (
    <section aria-label={t('note.local.title')} data-testid="local-graph">
      <div className="mb-2 flex items-center gap-2 px-1">
        <Symbol name="graph" className="h-4 w-4 text-mist-500" />
        <h3 className="text-[11px] font-semibold tracking-wider text-mist-500 uppercase">{t('note.local.title')}</h3>
        <div className="ml-auto inline-flex rounded-full border border-ink-700 p-0.5 text-xs" role="radiogroup" aria-label={t('note.local.depthGroup')}>
          {[1, 2, 3].map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={depth === value}
              aria-label={t('note.local.depth', { depth: value })}
              title={t('note.local.depth', { depth: value })}
              onClick={() => chooseDepth(value)}
              className={'min-w-7 rounded-full px-2 py-0.5 ' + (depth === value ? 'bg-accent-500/15 text-accent-400' : 'text-mist-400 hover:text-mist-100')}
            >
              {value}
            </button>
          ))}
        </div>
        <button type="button" onClick={onShowInGraph} className="rounded-full p-1.5 text-mist-400 hover:bg-ink-850 hover:text-mist-100" title={t('note.local.inGraph')} aria-label={t('note.local.inGraph')}>
          <Symbol name="open" className="h-4 w-4" />
        </button>
      </div>
      <div className="relative h-64 overflow-hidden rounded-2xl border border-ink-700 bg-ink-900/60">
        <canvas ref={canvas} className="block h-full w-full touch-none" style={{ cursor: 'grab' }} role="img" aria-label={t('note.local.canvas')} />
        {(alone || failed) && (
          <p className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-xs text-mist-500">{failed ? t('errors.byCode.internal_error') : t('note.local.alone')}</p>
        )}
      </div>
      {data && data.nodes.length >= LIMIT && <p className="mt-1 px-1 text-[11px] text-mist-600">{t('note.local.limited', { count: LIMIT })}</p>}
    </section>
  )
}
