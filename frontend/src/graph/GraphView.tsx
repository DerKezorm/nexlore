/**
 * The zoomable graph: WebGL for dots, circles and lines (`gl.ts`), a 2D canvas above it for the labels.
 *
 * Semantic zoom: every group is a circle on the map. As long as it is small on screen, it is a closed bubble with its
 * name and note count, and links into it are bundled into one line. Once it grows past a size on screen, it opens:
 * the bubble fades, its subgroups and notes fade in. The same on every level, from spaces to single notes.
 *
 * Mouse: drag to move, wheel to zoom, click to choose, double click to open, a click on a closed circle flies into
 * it. Touch: one finger moves, two fingers zoom (pinch).
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { THEME_EVENT } from '../lib/theme'
import { GraphGL, MAX_DOT, MIN_DOT, OPEN_TO, type Camera, type Colors } from './gl'
import { closedLabelPriority, drawLabels, type LabelItem } from './labels'
import { openness, type Scene, type SceneGroup } from './scene'

const MAX_ZOOM = 12

export type GraphHandle = {
  fitAll: () => void
  zoomBy: (factor: number) => void
  flyToGroup: (id: number) => void
  /** Flies so that the point is in the middle and its group is open. */
  flyToPoint: (x: number, y: number, groupRadius: number) => void
  camera: () => Camera
}

export type Hover = { kind: 'note' | 'group'; id: number; x: number; y: number }

type Props = {
  scene: Scene
  /** Counts up whenever the scene's data changed. */
  revision: number
  hideDaily: boolean
  selected: number | null
  onSelect: (id: number | null) => void
  onOpen: (id: number) => void
  onCentre: (group: SceneGroup | null) => void
  onHover: (hover: Hover | null) => void
  /** The camera moved: which part of the map is on screen. */
  onView: (camera: Camera, width: number, height: number) => void
  groupLabel: (group: SceneGroup) => string
  countLabel: (count: number) => string
  /** Accessible name of the canvas. */
  label: string
}

/** A bubble or note on screen, as a button for Tab. */
type Place = { kind: 'group' | 'note'; id: number; x: number; y: number; name: string; count?: number; weight: number }
/** At most this many: more than a screen holds would only lengthen the way through by Tab. */
const PLACES = 40

function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

function smoothstep(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function rgb(hex: string): [number, number, number] {
  const value = parseInt(hex.replace('#', '').slice(0, 6), 16)
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255]
}

function readColors(): Colors {
  const style = getComputedStyle(document.documentElement)
  const v = (name: string) => style.getPropertyValue(name).trim() || '#888888'
  return {
    text: v('--color-mist-200'),
    dim: v('--color-mist-500'),
    bg: v('--color-ink-950'),
    edge: rgb(v('--color-mist-500')),
    accent: rgb(v('--color-accent-500')),
    light: document.documentElement.getAttribute('data-theme') === 'light',
  }
}

/** The strip the hint at the bottom of the map takes, kept free when everything is shown. */
const FIT_HINT = 56

function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, '0')
  return hex.length === 7 ? hex + a : hex
}

export const GraphView = forwardRef<GraphHandle, Props>(function GraphView(props, ref) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const gl = useRef<GraphGL | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const camera = useRef<Camera>({ x: 0, y: 0, k: 0.05 })
  const size = useRef({ w: 800, h: 600 })
  const colors = useRef<Colors | null>(null)
  const hover = useRef<Hover | null>(null)
  const frame = useRef(0)
  const flight = useRef<{ from: Camera; to: Camera; start: number; duration: number } | null>(null)
  const seen = useRef<Place[]>([])
  const settle = useRef(0)
  const [placesShown, setPlacesShown] = useState<Place[]>([])
  const fitted = useRef(false)
  const latest = useRef(props)
  latest.current = props
  // What the buffers were built from; anything that differs is built again before the next frame.
  const built = useRef({ revision: -1, band: -1, focus: null as number | null, hide: false, flags: '', points: [] as number[], bubbles: [] as number[] })
  // Neighbours of the focus and the groups around them: worked out once per focus and data, not per frame.
  const around = useRef({ key: '', near: new Set<number>(), marked: new Set<number>() })
  const centreId = useRef<number | null | undefined>(undefined)
  // Where the mouse is, so what lies under it can be looked at again when the map moved under a still mouse.
  const mouse = useRef<{ x: number; y: number } | null>(null)
  const lookAgain = useRef<() => void>(() => undefined)

  const focusId = () => (hover.current?.kind === 'note' ? hover.current.id : latest.current.selected)

  const draw = useCallback(() => {
    frame.current = 0
    const canvas = canvasRef.current
    const overlay = overlayRef.current
    const renderer = gl.current
    if (!canvas || !overlay || !renderer) return
    const { scene, revision, hideDaily } = latest.current
    const { w, h } = size.current
    const dpr = window.devicePixelRatio || 1
    const col = (colors.current ??= readColors())

    const f = flight.current
    if (f) {
      const progress = Math.min(1, (performance.now() - f.start) / f.duration)
      const e = ease(progress)
      const lk = Math.log(f.from.k) + (Math.log(f.to.k) - Math.log(f.from.k)) * e
      camera.current = { x: f.from.x + (f.to.x - f.from.x) * e, y: f.from.y + (f.to.y - f.from.y) * e, k: Math.exp(lk) }
      if (progress >= 1) {
        flight.current = null
        lookAgain.current()
      } else frame.current = requestAnimationFrame(draw)
    }
    const cam = camera.current
    scene.hideDaily = hideDaily

    // Buffers: again only when something they depend on changed.
    const state = built.current
    const focus = focusId()
    const band = scene.band(cam.k)
    if (state.revision !== revision) {
      const points = scene.pointBuffer()
      renderer.points.upload(points.data, points.ids.length)
      const bubbles = scene.bubbleBuffer()
      renderer.bubbles.upload(bubbles.data, bubbles.ids.length * 6)
      state.points = points.ids
      state.bubbles = bubbles.ids
      state.flags = ''
      // What the spaces are drawn in, for a look from outside (the tests).
      canvasRef.current?.setAttribute('data-colours', scene.spaceColours().join(' '))
    }
    if (state.revision !== revision || state.band !== band || state.focus !== focus || state.hide !== hideDaily || state.flags === '') {
      const lines = scene.lineBuffers(cam.k, focus)
      renderer.lines.upload(lines.lines, lines.lineCount)
      renderer.bands.upload(lines.bands, lines.bandCount)
    }
    const aroundKey = `${focus}|${revision}`
    if (around.current.key !== aroundKey) {
      const near = focus !== null ? scene.neighbours(focus) : new Set<number>()
      around.current = { key: aroundKey, near, marked: focus !== null ? scene.markedGroups([focus, ...near]) : new Set<number>() }
    }
    const near = around.current.near
    const flagKey = `${focus}|${latest.current.selected}|${hover.current?.kind}:${hover.current?.id}|${hideDaily}|${revision}`
    if (state.flags !== flagKey) {
      renderer.points.setFlags(scene.pointFlags(state.points, focus, latest.current.selected, near))
      renderer.bubbles.setFlags(scene.bubbleFlags(state.bubbles, hover.current?.kind === 'group' ? hover.current.id : null, around.current.marked))
      state.flags = flagKey
    }
    state.revision = revision
    state.band = band
    state.focus = focus
    state.hide = hideDaily

    renderer.render(cam, w, h, dpr, col, focus !== null)

    // Labels.
    const ctx = overlay.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const sx = (x: number) => (x - cam.x) * cam.k + w / 2
    const sy = (y: number) => (y - cam.y) * cam.k + h / 2
    const items: LabelItem[] = []
    const places: Place[] = []
    const marked = focus !== null ? around.current.marked : null
    for (const group of scene.groups.values()) {
      const alpha = scene.groupAlpha(group, cam.k)
      const r = group.r * cam.k
      const x = sx(group.x)
      const y = sy(group.y)
      if (x + r < 0 || x - r > w || y + r < 0 || y - r > h) continue
      const name = latest.current.groupLabel(group)
      if ((alpha.closed > 0.05 && r > 16) || alpha.open > 0.5) {
        places.push({ kind: 'group', id: group.id, x, y, name, count: group.total, weight: 1e6 + r })
      }
      if (alpha.closed > 0.05 && r > 16) {
        const dimmed = marked && !marked.has(group.id) ? 0.5 : 1
        const fontSize = Math.max(11, Math.min(20, r * 0.2))
        items.push({
          x, y, text: name, sub: r > 34 ? latest.current.countLabel(group.total) : undefined, size: fontSize, weight: 600, icon: group.icon, iconColor: group.color,
          // Opening, the name in the middle fades faster than the bubble, so it never lies over the names inside.
          // Never both names of one bubble at once (the middle one and the one on top stood over each other, P4.11).
          color: col.text, subColor: col.dim, alpha: alpha.closed * Math.max(0, 1 - 2 * alpha.open) * dimmed, baseline: 'middle',
          priority: closedLabelPriority(r, alpha.open), maxWidth: Math.max(60, r * 1.7),
        })
      }
      const fade = 1 - smoothstep(Math.max(w, h) * 0.9, Math.max(w, h) * 1.6, r)
      const openAlpha = Math.max(0, 2 * alpha.open - 1) * fade
      if (openAlpha > 0.02) {
        const top = y - r + (group.depth === 1 ? 22 : 16)
        items.push({
          x, y: top, text: group.depth === 1 ? name.toUpperCase() : name, size: group.depth === 1 ? 15 : 12, icon: group.icon,
          weight: group.depth === 1 ? 700 : 600, color: group.color, alpha: openAlpha * 0.95, baseline: 'middle',
          priority: 400 - group.depth,
        })
      }
    }
    const x0 = cam.x - w / 2 / cam.k - 40 / cam.k
    const x1 = cam.x + w / 2 / cam.k + 40 / cam.k
    const y0 = cam.y - h / 2 / cam.k - 20 / cam.k
    const y1 = cam.y + h / 2 / cam.k + 20 / cam.k
    for (const note of scene.notes.values()) {
      if (note.x < x0 || note.x > x1 || note.y < y0 || note.y > y1) continue
      const a = scene.noteAlpha(note, cam.k)
      if (a < 0.03) continue
      const dot = Math.min(MAX_DOT, Math.max(MIN_DOT, note.r * cam.k))
      const isFocus = note.id === focus
      const isNear = near.has(note.id)
      const labelAlpha = isFocus || isNear ? a : a * smoothstep(3.2, 6, note.r * cam.k)
      if (labelAlpha < 0.03) continue
      places.push({ kind: 'note', id: note.id, x: sx(note.x), y: sy(note.y), name: note.title, weight: note.r })
      items.push({
        x: sx(note.x), y: sy(note.y) + dot + 5, text: note.title, size: isFocus ? 13 : 12, weight: isFocus ? 600 : 500,
        color: isFocus ? `rgb(${col.accent.map((c) => Math.round(c * 255)).join(',')})` : col.text,
        alpha: focus !== null && !isFocus && !isNear ? labelAlpha * 0.5 : labelAlpha, baseline: 'top',
        priority: isFocus ? 1000 : isNear ? 500 : note.r, halo: true,
      })
    }
    drawLabels(ctx, items, withAlpha(col.bg, 0.9), w, h)
    // The places on screen, the biggest first and at most PLACES, for Tab and screen readers once the map stands still.
    const inView = places.filter((place) => place.x >= 0 && place.x <= w && place.y >= 0 && place.y <= h).sort((a, b) => b.weight - a.weight)
    // Half for bubbles, half for notes: many bubbles in view must not leave no way to a note.
    seen.current = [
      ...inView.filter((place) => place.kind === 'group').slice(0, PLACES / 2),
      ...inView.filter((place) => place.kind === 'note').slice(0, PLACES / 2),
    ]
    window.clearTimeout(settle.current)
    settle.current = window.setTimeout(() => setPlacesShown(seen.current), 250)

    // The zoom, readable from outside (tests of the finger gestures); written only when it changed.
    const zoom = cam.k.toPrecision(4)
    if (overlay.dataset.zoom !== zoom) overlay.dataset.zoom = zoom
    const centre = scene.centre(cam)
    if ((centre?.id ?? null) !== centreId.current) {
      centreId.current = centre?.id ?? null
      latest.current.onCentre(centre)
    }
    latest.current.onView(cam, w, h)
  }, [])

  const redraw = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(draw)
  }, [draw])

  // ---- camera ----------------------------------------------------------------------------------------------------

  const fitCamera = useCallback((): Camera => {
    const { scene } = latest.current
    const { w, h } = size.current
    if (!scene.spaces.length) return { x: 0, y: 0, k: 0.05 }
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const space of scene.spaces) {
      minX = Math.min(minX, space.ox - space.r)
      maxX = Math.max(maxX, space.ox + space.r)
      minY = Math.min(minY, space.oy - space.r)
      maxY = Math.max(maxY, space.oy + space.r)
    }
    // The hint at the bottom keeps its strip: the spaces fit above it (it covered one, P4.11).
    const room = Math.max(h - FIT_HINT, h * 0.6)
    let k = Math.min((w * 0.94) / Math.max(maxX - minX, 1), (room * 0.94) / Math.max(maxY - minY, 1))
    if (!Number.isFinite(k) || k <= 0) return { x: 0, y: 0, k: 0.05 }
    // Not on the edge of opening: a space half open shows its names twice over and its inside pale.
    for (let step = 0; step < 12 && scene.spaces.some((space) => openness(space.r, k) > 0.08 && openness(space.r, k) < 0.92); step++) k *= 0.9
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 + (h - room) / 2 / k, k }
  }, [])

  const clampZoom = useCallback(
    (k: number) => Math.min(MAX_ZOOM, Math.max(fitCamera().k * 0.5, 1e-4, Number.isFinite(k) ? k : 1e-4)),
    [fitCamera],
  )

  const fly = useCallback(
    (to: Camera, duration = 700) => {
      // Asked for less motion: the camera is there at once (P8.21).
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) duration = 1
      flight.current = { from: { ...camera.current }, to: { ...to, k: clampZoom(to.k) }, start: performance.now(), duration }
      // What was under the mouse moves away: its hint goes, and comes back for whatever is there when the flight ends.
      if (hover.current) {
        hover.current = null
        latest.current.onHover(null)
      }
      redraw()
    },
    [redraw, clampZoom],
  )

  useImperativeHandle(
    ref,
    () => ({
      fitAll: () => fly(fitCamera()),
      zoomBy: (factor: number) => fly({ ...camera.current, k: camera.current.k * factor }, 280),
      flyToGroup: (id: number) => {
        const group = latest.current.scene.groups.get(id)
        if (!group) return
        const { w, h } = size.current
        fly({ x: group.x, y: group.y, k: (Math.min(w, h) * 0.44) / group.r })
      },
      flyToPoint: (x: number, y: number, groupRadius: number) => {
        // Far enough in that the group is open and the dot has its label.
        const k = Math.max(camera.current.k, (OPEN_TO * 1.15) / Math.max(groupRadius, 1), 1.2)
        fly({ x, y, k }, 900)
      },
      camera: () => ({ ...camera.current }),
    }),
    [fly, fitCamera],
  )

  // ---- set up: WebGL, size, theme ----------------------------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current!
    const overlay = overlayRef.current!
    const start = () => {
      try {
        gl.current = new GraphGL(canvas)
        built.current = { revision: -1, band: -1, focus: null, hide: false, flags: '', points: [], bubbles: [] }
        setUnsupported(false)
      } catch {
        gl.current = null
        setUnsupported(true)
      }
    }
    start()
    const onLost = (event: Event) => {
      event.preventDefault()
      gl.current = null
    }
    const onRestored = () => {
      start()
      redraw()
    }
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)
    const observer = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      size.current = { w: rect.width, h: rect.height }
      for (const c of [canvas, overlay]) {
        c.width = Math.max(1, Math.round(rect.width * dpr))
        c.height = Math.max(1, Math.round(rect.height * dpr))
      }
      // Fitted once the canvas has a size: at 0 wide (a hidden tab) the zoom would be 0 and stay so.
      if (!fitted.current && latest.current.scene.spaces.length && rect.width > 1 && rect.height > 1) {
        fitted.current = true
        camera.current = fitCamera()
      }
      redraw()
    })
    observer.observe(canvas)
    const onTheme = () => {
      colors.current = null
      redraw()
    }
    window.addEventListener(THEME_EVENT, onTheme)
    return () => {
      observer.disconnect()
      window.removeEventListener(THEME_EVENT, onTheme)
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      cancelAnimationFrame(frame.current)
      frame.current = 0
      gl.current?.destroy()
      gl.current = null
    }
  }, [fitCamera, redraw])

  // The first overview: the whole map in view.
  useEffect(() => {
    if (!fitted.current && props.scene.spaces.length && size.current.w > 1) {
      fitted.current = true
      camera.current = fitCamera()
    }
    redraw()
  }, [props.revision, props.selected, props.hideDaily, props.scene, fitCamera, redraw])

  // ---- pointer -----------------------------------------------------------------------------------------------------

  useEffect(() => {
    const canvas = overlayRef.current!
    const pointers = new Map<number, { x: number; y: number }>()
    let moved = 0
    let pinch: { distance: number; k: number } | null = null
    let lastClick = { id: -1, time: 0 }

    const local = (e: PointerEvent | WheelEvent) => {
      const rect = canvas.getBoundingClientRect()
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }

    const setHover = (next: Hover | null) => {
      const current = hover.current
      if (current?.id === next?.id && current?.kind === next?.kind) return
      hover.current = next
      canvas.style.cursor = next ? 'pointer' : 'grab'
      latest.current.onHover(next)
      redraw()
    }

    const hitAt = (px: number, py: number): Hover | null => {
      const { w, h } = size.current
      const found = latest.current.scene.hit(px, py, camera.current, w, h)
      if (!found) return null
      const cam = camera.current
      const scene = latest.current.scene
      if (found.kind === 'note') {
        const note = scene.notes.get(found.id)!
        const dot = Math.min(MAX_DOT, Math.max(MIN_DOT, note.r * cam.k))
        return { kind: 'note', id: found.id, x: (note.x - cam.x) * cam.k + w / 2, y: (note.y - cam.y) * cam.k + h / 2 + dot }
      }
      const group = scene.groups.get(found.id)!
      return { kind: 'group', id: found.id, x: (group.x - cam.x) * cam.k + w / 2, y: (group.y - cam.y) * cam.k + h / 2 + group.r * cam.k }
    }

    const zoomAt = (px: number, py: number, factor: number) => {
      const c = camera.current
      const { w, h } = size.current
      const k = clampZoom(c.k * factor)
      const wx = (px - w / 2) / c.k + c.x
      const wy = (py - h / 2) / c.k + c.y
      camera.current = { k, x: wx - (px - w / 2) / k, y: wy - (py - h / 2) / k }
      flight.current = null
      redraw()
    }

    const onDown = (e: PointerEvent) => {
      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        // A pointer the browser no longer knows (lifted in between): the gesture works without the capture.
      }
      pointers.set(e.pointerId, local(e))
      moved = 0
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), k: camera.current.k }
      }
    }

    lookAgain.current = () => {
      if (mouse.current && pointers.size === 0) setHover(hitAt(mouse.current.x, mouse.current.y))
    }

    const onMove = (e: PointerEvent) => {
      const p = local(e)
      if (e.pointerType === 'mouse') mouse.current = p
      const previous = pointers.get(e.pointerId)
      if (!previous) {
        if (e.pointerType === 'mouse') setHover(hitAt(p.x, p.y))
        return
      }
      pointers.set(e.pointerId, p)
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()]
        const distance = Math.hypot(a.x - b.x, a.y - b.y)
        zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, (pinch.k * (distance / Math.max(pinch.distance, 1))) / camera.current.k)
        moved += 10
        return
      }
      const dx = p.x - previous.x
      const dy = p.y - previous.y
      moved += Math.abs(dx) + Math.abs(dy)
      if (moved > 3) {
        canvas.style.cursor = 'grabbing'
        const c = camera.current
        camera.current = { ...c, x: c.x - dx / c.k, y: c.y - dy / c.k }
        flight.current = null
        if (hover.current) setHover(null)
        redraw()
      }
    }

    const onUp = (e: PointerEvent) => {
      const p = local(e)
      pointers.delete(e.pointerId)
      if (pointers.size < 2) pinch = null
      canvas.style.cursor = hover.current ? 'pointer' : 'grab'
      if (moved > 3 || pointers.size > 0 || e.type === 'pointercancel') return
      const hit = hitAt(p.x, p.y)
      const { onSelect, onOpen, scene } = latest.current
      if (!hit) {
        onSelect(null)
        return
      }
      if (hit.kind === 'group') {
        const group = scene.groups.get(hit.id)!
        const { w, h } = size.current
        fly({ x: group.x, y: group.y, k: (Math.min(w, h) * 0.44) / group.r })
        return
      }
      const now = performance.now()
      if (lastClick.id === hit.id && now - lastClick.time < 350) onOpen(hit.id)
      else onSelect(hit.id)
      lastClick = { id: hit.id, time: now }
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const p = local(e)
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)))
      mouse.current = p
      setHover(hitAt(p.x, p.y))
    }

    const onLeave = () => {
      mouse.current = null
      if (pointers.size === 0) setHover(null)
    }

    // Keys, when the map has the focus: arrows move, plus and minus zoom, 0 shows everything.
    const onKey = (e: KeyboardEvent) => {
      const c = camera.current
      const step = 80 / c.k
      const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
      if (moves[e.key]) {
        fly({ ...c, x: c.x + moves[e.key][0], y: c.y + moves[e.key][1] }, 160)
      } else if (e.key === '+' || e.key === '=') {
        fly({ ...c, k: c.k * 1.6 }, 220)
      } else if (e.key === '-' || e.key === '_') {
        fly({ ...c, k: c.k / 1.6 }, 220)
      } else if (e.key === '0') {
        fly(fitCamera())
      } else return
      e.preventDefault()
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('pointerleave', onLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('keydown', onKey)
    return () => {
      canvas.removeEventListener('keydown', onKey)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [clampZoom, fly, fitCamera, redraw])

  const choosePlace = (place: Place) => {
    const { scene, onOpen } = latest.current
    if (place.kind === 'note') return onOpen(place.id)
    const group = scene.groups.get(place.id)
    if (!group) return
    const { w, h } = size.current
    fly({ x: group.x, y: group.y, k: (Math.min(w, h) * 0.44) / group.r })
  }

  return (
    <div className="relative h-full w-full">
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" aria-hidden="true" />
      <canvas
        ref={overlayRef}
        className="absolute inset-0 block h-full w-full touch-none rounded-none focus-visible:outline-2 focus-visible:outline-accent-500"
        style={{ cursor: 'grab' }}
        role="img"
        tabIndex={0}
        aria-label={props.label}
        aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight + - 0"
        data-testid="graph-canvas"
      />
      {/* The places of the map for the keyboard and screen readers: unseen until one has the focus (P8.10). */}
      <ul className="pointer-events-none absolute inset-0 m-0 list-none p-0" aria-label={t('graph.places')} data-testid="graph-places">
        {placesShown.map((place) => (
          <li key={place.kind + place.id}>
            <button
              type="button"
              onClick={() => choosePlace(place)}
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent-500 bg-ink-900 px-2 py-0.5 text-xs whitespace-nowrap text-mist-100 opacity-0 focus:pointer-events-auto focus:opacity-100 focus:outline-none"
              style={{ left: place.x, top: place.y }}
              data-place={place.kind}
            >
              {place.kind === 'group' ? t('graph.placeGroup', { name: place.name, count: place.count ?? 0 }) : place.name}
            </button>
          </li>
        ))}
      </ul>
      {unsupported && (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <p className="max-w-md rounded-2xl border border-ink-700 bg-ink-900/90 px-5 py-4 text-center text-sm text-mist-400">
            {t('graph.noWebgl')}
          </p>
        </div>
      )}
    </div>
  )
})
