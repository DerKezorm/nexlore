/**
 * The drawing surface: a window onto the endless drawing, through Pointer Events.
 *
 * - A pen draws with its pressure, a mouse with a pressure from its speed; every point the browser saw between two
 *   frames counts (`getCoalescedEvents`). A finger (`touch`) moves the picture, never draws.
 * - Space, the right or the middle button held and dragged moves the picture; the wheel moves it, Ctrl (Cmd) with
 *   the wheel zooms around the pointer. Only where the surface `moves` (a block while it is drawn in, the file page).
 * - The eraser takes whole strokes or only what it passes; the lasso chooses strokes, a drag on the chosen ones moves
 *   them. Writing on at the edge pushes the picture along.
 *
 * The view (`place`) belongs to whoever holds the surface; the strokes to the drawing (`useInk`). A change counts when
 * the pointer is lifted: one step back each.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import {
  INK,
  LIMITS,
  eraseWhole,
  erasePart,
  followEdge,
  inBox,
  keptPoint,
  lassoPick,
  moveStrokes,
  panBy,
  pickedBox,
  pressureOf,
  toDrawing,
  viewBoxOf,
  zoomAt,
  type InkStroke,
  type Placement,
  type Point,
} from '../lib/ink'
import { eraserRadius, newStroke, type Tools } from './logic'
import { Paper, StrokePath, Strokes } from './paint'
import type { InkController } from './useInk'

type Props = {
  ink: InkController
  tools: Tools
  place: Placement
  onPlace: (next: Placement) => void
  /** Moving and zooming. */
  moves: boolean
  /** Drawing; without it the surface only shows. */
  draws: boolean
  /** Height in pixels; without it the surface fills its parent. */
  height?: number
  /** Its size in pixels, as soon as it is known and whenever it changes. */
  onSize?: (width: number, height: number) => void
  /** Laid over something else (the cards of a canvas): no ground and no paper of its own, only the strokes. */
  clear?: boolean
  /**
   * A layer beside the surface (outside its stacking) that draws the strokes in ink once more, there to be blended
   * with what lies under them: the canvas turns white ink dark on a light card in the dark (`canvas.css`).
   */
  echo?: HTMLElement | null
  className?: string
  children?: ReactNode
}

type Gesture =
  | { kind: 'pan'; id: number; x: number; y: number }
  | { kind: 'draw'; id: number; stroke: InkStroke; done: InkStroke[] }
  | { kind: 'erase'; id: number; strokes: InkStroke[] }
  | { kind: 'lasso'; id: number; polygon: Point[] }
  | { kind: 'move'; id: number; from: Point; strokes: InkStroke[] }

/** Points closer than this on the screen add nothing to a stroke. */
const MIN_STEP_PX = 1.2

export function InkSurface({ ink, tools, place, onPlace, moves, draws, height, onSize, clear = false, echo = null, className = '', children }: Props) {
  const root = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: height ?? 0 })
  const gesture = useRef<Gesture | null>(null)
  // Several pointer events may come before the page draws again: the view as it is now, not as last drawn.
  const placed = useRef(place)
  placed.current = place
  const [live, setLive] = useState<InkStroke | null>(null)
  const [preview, setPreview] = useState<InkStroke[] | null>(null)
  const [lasso, setLasso] = useState<Point[] | null>(null)
  const [ring, setRing] = useState<Point | null>(null)
  const [panning, setPanning] = useState(false)

  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const measure = () => {
      const next = { width: element.clientWidth, height: element.clientHeight }
      setSize((before) => (before.width === next.width && before.height === next.height ? before : next))
    }
    measure()
    const watcher = new ResizeObserver(measure)
    watcher.observe(element)
    return () => watcher.disconnect()
  }, [])
  useEffect(() => {
    if (size.width) onSize?.(size.width, size.height)
    // Told of a new size only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size])

  const move = useCallback(
    (next: Placement) => {
      placed.current = next
      onPlace(next)
    },
    [onPlace],
  )

  // The wheel: only where the surface moves (elsewhere the page scrolls past it). Passive listeners cannot keep the
  // page from scrolling, hence by hand.
  useEffect(() => {
    const element = root.current
    if (!element || !moves) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const box = element.getBoundingClientRect()
      const now = placed.current
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1
      if (event.ctrlKey || event.metaKey) {
        move(zoomAt(now, Math.exp(-event.deltaY * unit * 0.0025), event.clientX - box.left, event.clientY - box.top))
      } else {
        const dx = (event.shiftKey ? event.deltaY : event.deltaX) * unit
        const dy = event.shiftKey ? 0 : event.deltaY * unit
        move(panBy(now, -dx, -dy))
      }
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [moves, move])

  const local = (event: { clientX: number; clientY: number }): [number, number] => {
    const box = root.current!.getBoundingClientRect()
    return [event.clientX - box.left, event.clientY - box.top]
  }
  const pointAt = (event: { clientX: number; clientY: number }): Point => {
    const [px, py] = local(event)
    return toDrawing(placed.current, px, py)
  }

  const shown = preview ?? ink.strokes
  const chosenBox = pickedBox(shown, ink.selection)
  const drawing = draws && !ink.readonly

  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (gesture.current) return
    const element = root.current!
    if (moves || drawing) element.focus({ preventScroll: true })
    const wantsPan = event.button === 1 || event.button === 2 || ink.space.current || event.pointerType === 'touch'
    if (moves && wantsPan) {
      event.preventDefault()
      element.setPointerCapture?.(event.pointerId)
      gesture.current = { kind: 'pan', id: event.pointerId, x: event.clientX, y: event.clientY }
      setPanning(true)
      return
    }
    if (!drawing || event.button !== 0 || event.pointerType === 'touch') return
    event.preventDefault()
    element.setPointerCapture?.(event.pointerId)
    const p = pointAt(event)
    if (tools.tool === 'lasso') {
      if (ink.selection.length && inBox(p, chosenBox)) {
        gesture.current = { kind: 'move', id: event.pointerId, from: p, strokes: ink.strokes }
        return
      }
      ink.select([])
      gesture.current = { kind: 'lasso', id: event.pointerId, polygon: [p] }
      setLasso([p])
      return
    }
    if (ink.selection.length) ink.select([])
    if (tools.tool === 'eraser') {
      const erase = tools.eraser === 'stroke' ? eraseWhole : erasePart
      const strokes = erase(ink.strokes, p, eraserRadius(tools, placed.current.z))
      gesture.current = { kind: 'erase', id: event.pointerId, strokes }
      setPreview(strokes)
      setRing(p)
      return
    }
    if (ink.strokes.length >= LIMITS.strokes) return
    const start = keptPoint(p[0], p[1], pressureOf(event.pointerType, event.pressure, null, p, placed.current.z))
    const stroke = newStroke(tools, start)
    gesture.current = { kind: 'draw', id: event.pointerId, stroke, done: [] }
    setLive({ ...stroke })
  }

  const moved = (event: ReactPointerEvent<HTMLDivElement>) => {
    const now = gesture.current
    if (!now) {
      if (drawing && tools.tool === 'eraser' && event.pointerType !== 'touch') setRing(pointAt(event))
      return
    }
    if (event.pointerId !== now.id) return
    if (now.kind === 'pan') {
      move(panBy(placed.current, event.clientX - now.x, event.clientY - now.y))
      now.x = event.clientX
      now.y = event.clientY
      return
    }
    const native = event.nativeEvent
    const coalesced = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : []
    const events = coalesced.length ? coalesced : [native]
    const z = placed.current.z
    if (now.kind === 'draw') {
      for (const one of events) {
        const p = pointAt(one)
        const last = now.stroke.pts[now.stroke.pts.length - 1]
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) * z < MIN_STEP_PX) continue
        now.stroke.pts.push(keptPoint(p[0], p[1], pressureOf(one.pointerType, one.pressure, last, p, z)))
        // A stroke as long as a file takes: it goes on as the next one, from the same point.
        if (now.stroke.pts.length >= LIMITS.points) {
          now.done.push(now.stroke)
          now.stroke = { ...now.stroke, pts: [now.stroke.pts[now.stroke.pts.length - 1]] }
        }
      }
      setLive({ ...now.stroke })
      if (moves) {
        const [px, py] = local(event)
        const [dx, dy] = followEdge(px, py, size.width, size.height, z)
        if (dx || dy) move({ ...placed.current, x: placed.current.x + dx, y: placed.current.y + dy })
      }
      return
    }
    if (now.kind === 'erase') {
      const erase = tools.eraser === 'stroke' ? eraseWhole : erasePart
      let strokes = now.strokes
      for (const one of events) strokes = erase(strokes, pointAt(one), eraserRadius(tools, z))
      setRing(pointAt(event))
      if (strokes !== now.strokes) {
        now.strokes = strokes
        setPreview(strokes)
      }
      return
    }
    if (now.kind === 'lasso') {
      for (const one of events) now.polygon.push(pointAt(one))
      setLasso([...now.polygon])
      return
    }
    const p = pointAt(event)
    setPreview(moveStrokes(now.strokes, ink.selection, p[0] - now.from[0], p[1] - now.from[1]))
  }

  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    const now = gesture.current
    if (!now || event.pointerId !== now.id) return
    gesture.current = null
    root.current?.releasePointerCapture?.(event.pointerId)
    if (now.kind === 'pan') return setPanning(false)
    if (now.kind === 'draw') {
      setLive(null)
      if (event.type === 'pointercancel') return
      ink.commit([...ink.strokes, ...now.done, now.stroke].slice(0, LIMITS.strokes))
      return
    }
    if (now.kind === 'erase') {
      setPreview(null)
      if (event.pointerType === 'touch') setRing(null)
      if (now.strokes !== ink.strokes && event.type !== 'pointercancel') ink.commit(now.strokes)
      return
    }
    if (now.kind === 'lasso') {
      setLasso(null)
      ink.select(lassoPick(ink.strokes, now.polygon))
      return
    }
    const p = pointAt(event)
    setPreview(null)
    const [dx, dy] = [p[0] - now.from[0], p[1] - now.from[1]]
    if ((dx || dy) && event.type !== 'pointercancel') ink.commit(moveStrokes(now.strokes, ink.selection, dx, dy))
  }

  const width = size.width || 600
  const tall = height ?? (size.height || 400)
  const cursor = panning
    ? 'cursor-grabbing'
    : !drawing
      ? moves
        ? 'cursor-grab'
        : ''
      : tools.tool === 'eraser'
        ? 'cursor-cell'
        : tools.tool === 'lasso'
          ? 'cursor-default'
          : 'cursor-crosshair'
  const radius = eraserRadius(tools, place.z)
  return (
    <div
      ref={root}
      tabIndex={moves || drawing ? -1 : undefined}
      data-ink-surface=""
      data-tool={drawing ? tools.tool : undefined}
      data-zoom={Math.round(place.z * 100)}
      className={'relative overflow-hidden text-mist-100 outline-none ' + (clear ? '' : 'bg-ink-900 ') + cursor + ' ' + (height === undefined ? 'h-full w-full ' : 'w-full ') + className}
      style={{ height, touchAction: moves || drawing ? 'none' : 'pan-y' }}
      onPointerDown={down}
      onPointerMove={moved}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={() => !gesture.current && setRing(null)}
      onContextMenu={(event) => moves && event.preventDefault()}
    >
      <svg className="block h-full w-full select-none" viewBox={viewBoxOf(place, width, tall)} preserveAspectRatio="xMinYMin slice">
        {!clear && <Paper bg={ink.bg} box={{ x: place.x, y: place.y, w: width / place.z, h: tall / place.z }} />}
        <Strokes strokes={shown} picked={ink.selection} />
        {live && <StrokePath stroke={live} />}
        {lasso && lasso.length > 1 && (
          <path
            d={'M' + lasso.map((p) => `${p[0]} ${p[1]}`).join('L') + 'Z'}
            className="fill-accent-500/10 stroke-accent-400"
            strokeWidth={1.4}
            strokeDasharray="5 4"
            vectorEffect="non-scaling-stroke"
            data-lasso=""
          />
        )}
        {chosenBox && !lasso && (
          <rect
            x={chosenBox.x}
            y={chosenBox.y}
            width={chosenBox.w}
            height={chosenBox.h}
            className="cursor-move fill-transparent stroke-accent-400"
            strokeWidth={1.4}
            strokeDasharray="6 4"
            vectorEffect="non-scaling-stroke"
            data-chosen={ink.selection.length}
          />
        )}
        {ring && drawing && tools.tool === 'eraser' && (
          <circle cx={ring[0]} cy={ring[1]} r={radius} fill="none" className="stroke-mist-400" strokeWidth={1} vectorEffect="non-scaling-stroke" pointerEvents="none" />
        )}
      </svg>
      {children}
      {echo && createPortal(<InkEcho strokes={shown} live={live} picked={ink.selection} viewBox={viewBoxOf(place, width, tall)} />, echo)}
    </div>
  )
}

/** The strokes in ink only, for the layer beside the surface; picked ones dimmed as on the surface. */
function InkEcho({ strokes, live, picked, viewBox }: { strokes: InkStroke[]; live: InkStroke | null; picked: readonly number[]; viewBox: string }) {
  const chosen = new Set(picked)
  const kept: InkStroke[] = []
  const dimmed: number[] = []
  strokes.forEach((stroke, index) => {
    if (stroke.color !== INK) return
    if (chosen.has(index)) dimmed.push(kept.length)
    kept.push(stroke)
  })
  return (
    <svg className="block h-full w-full select-none" viewBox={viewBox} preserveAspectRatio="xMinYMin slice" data-ink-echo="">
      <Strokes strokes={kept} picked={dimmed} />
      {live && live.color === INK && <StrokePath stroke={live} />}
    </svg>
  )
}
