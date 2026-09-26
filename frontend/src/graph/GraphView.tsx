/**
 * The zoomable graph, drawn on a canvas.
 *
 * Semantic zoom: every folder is a circle on the map. As long as it is small on screen, it is drawn as a closed
 * bubble with its name and note count, and links into it are bundled into one line. Once it grows past a size on
 * screen, it opens: the bubble fades, its subfolders and notes fade in. This works the same on every level, so
 * zooming leads from spaces to folders to subfolders to single notes.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'

import i18n from '../i18n'
import { ancestry, neighbours, type Cluster, type Vault } from '../lib/vault'
import { THEME_EVENT } from '../lib/theme'
import type { Layout } from './layout'

/** A folder starts opening at this radius on screen and is fully open at the second. */
const OPEN_FROM = 80
const OPEN_TO = 170
const MAX_ZOOM = 9
const MAX_DOT = 15

export type GraphHandle = {
  flyToNote: (id: string) => void
  flyToCluster: (id: string) => void
  fitAll: () => void
  zoomBy: (factor: number) => void
}

type Props = {
  vault: Vault
  layout: Layout
  selected: string | null
  hidden: Set<string>
  onSelect: (id: string | null) => void
  onOpen: (id: string) => void
  onFocus: (cluster: Cluster) => void
  onHover: (hover: Hover | null) => void
}

export type Hover = { kind: 'note' | 'cluster'; id: string; x: number; y: number }

type Camera = { x: number; y: number; k: number }

type Colors = { text: string; dim: string; edge: string; accent: string; bg: string; light: boolean }

function smoothstep(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** 0 while a folder is small on screen, 1 once it is big enough to show what is inside. */
function openness(layout: Layout, cluster: Cluster, k: number): number {
  if (cluster.depth === 0) return 1
  return smoothstep(OPEN_FROM, OPEN_TO, layout.clusters.get(cluster.id)!.r * k)
}

/**
 * The closed bubble fades out while the border of the open folder and its contents fade in, so a folder never looks
 * empty on the way. Labels that would overlap are sorted out further down.
 */
const shell = (o: number) => 1 - smoothstep(0.15, 0.75, o)
const ring = (o: number) => smoothstep(0.1, 0.5, o)
const inner = (o: number) => smoothstep(0.1, 0.6, o)

type Label = { x: number; y: number; w: number; h: number; priority: number; paint: () => void }

function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

function readColors(): Colors {
  const style = getComputedStyle(document.documentElement)
  const v = (name: string) => style.getPropertyValue(name).trim()
  return {
    text: v('--color-mist-200'),
    dim: v('--color-mist-500'),
    edge: v('--color-mist-500'),
    accent: v('--color-accent-500'),
    bg: v('--color-ink-950'),
    light: document.documentElement.getAttribute('data-theme') === 'light',
  }
}

function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, '0')
  return hex.length === 7 ? hex + a : hex
}

export const GraphView = forwardRef<GraphHandle, Props>(function GraphView(
  { vault, layout, selected, hidden, onSelect, onOpen, onFocus, onHover },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const camera = useRef<Camera>({ x: 0, y: 0, k: 0.5 })
  const size = useRef({ w: 800, h: 600 })
  const colors = useRef<Colors | null>(null)
  const hover = useRef<Hover | null>(null)
  const frame = useRef(0)
  const flight = useRef<{ from: Camera; to: Camera; start: number; duration: number } | null>(null)
  const focusId = useRef<string | null>(null)
  const props = useRef({ vault, layout, selected, hidden, onSelect, onOpen, onFocus, onHover })
  props.current = { vault, layout, selected, hidden, onSelect, onOpen, onFocus, onHover }

  const isHidden = useCallback((cluster: Cluster | null | undefined): boolean => {
    for (let c = cluster ?? null; c; c = c.parent) if (props.current.hidden.has(c.id)) return true
    return false
  }, [])

  const draw = useCallback(() => {
    frame.current = 0
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const { vault, layout, selected } = props.current
    const { w, h } = size.current
    const dpr = window.devicePixelRatio || 1
    const col = (colors.current ??= readColors())

    // A running flight moves the camera first.
    const f = flight.current
    if (f) {
      const t = Math.min(1, (performance.now() - f.start) / f.duration)
      const e = ease(t)
      const lk = Math.log(f.from.k) + (Math.log(f.to.k) - Math.log(f.from.k)) * e
      camera.current = { x: f.from.x + (f.to.x - f.from.x) * e, y: f.from.y + (f.to.y - f.from.y) * e, k: Math.exp(lk) }
      if (t >= 1) flight.current = null
      else frame.current = requestAnimationFrame(draw)
    }
    const { x: cx, y: cy, k } = camera.current
    const sx = (x: number) => (x - cx) * k + w / 2
    const sy = (y: number) => (y - cy) * k + h / 2

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    // Openness and visibility of every folder.
    const open = new Map<string, number>()
    const vis = new Map<string, number>()
    const walk = (c: Cluster, parentVis: number) => {
      const o = openness(layout, c, k)
      open.set(c.id, o)
      vis.set(c.id, parentVis)
      for (const child of c.children) walk(child, parentVis * (c.depth === 0 ? 1 : inner(o)))
    }
    walk(vault.root, 1)

    const focusNote = hover.current?.kind === 'note' ? hover.current.id : selected
    const near = focusNote ? neighbours(vault, focusNote) : null
    const noteAlpha = (id: string) => {
      const home = vault.home.get(id)!
      return vis.get(home.id)! * (home.depth === 0 ? 1 : inner(open.get(home.id)!))
    }

    // Representative of a note on the current zoom level: the outermost folder that is still closed, or the note.
    const representative = (id: string): string => {
      for (const c of ancestry(vault, id)) if (open.get(c.id)! < 0.5) return 'c:' + c.id
      return 'n:' + id
    }

    // Which folders contain the focused note or its neighbours; their closed bubbles get a ring.
    const marked = new Set<string>()
    if (focusNote && near) {
      for (const id of [focusNote, ...near]) for (const c of ancestry(vault, id)) marked.add(c.id)
    }

    // 1. Open folders: faint area and border.
    const clustersByDepth = [...vault.clusters.values()].filter((c) => c.depth > 0 && !isHidden(c)).sort((a, b) => a.depth - b.depth)
    for (const c of clustersByDepth) {
      const a = vis.get(c.id)! * ring(open.get(c.id)!)
      if (a < 0.01) continue
      const p = layout.clusters.get(c.id)!
      const r = p.r * k
      if (sx(p.x) + r < 0 || sx(p.x) - r > w || sy(p.y) + r < 0 || sy(p.y) - r > h) continue
      ctx.beginPath()
      ctx.arc(sx(p.x), sy(p.y), r, 0, Math.PI * 2)
      ctx.fillStyle = withAlpha(c.color, (col.light ? 0.05 : 0.035) * a)
      ctx.fill()
      ctx.lineWidth = c.depth === 1 ? 1.5 : 1
      ctx.setLineDash(c.depth === 1 ? [] : [4, 5])
      ctx.strokeStyle = withAlpha(c.color, (c.depth === 1 ? 0.35 : 0.28) * a)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // 2. Links: between notes, or bundled between closed folders.
    const bundles = new Map<string, { a: string; b: string; count: number; hot: boolean }>()
    for (const { from, to } of vault.links) {
      if (isHidden(vault.home.get(from)) || isHidden(vault.home.get(to))) continue
      const ra = representative(from)
      const rb = representative(to)
      if (ra === rb) continue
      const hot = !!focusNote && (from === focusNote || to === focusNote)
      if (ra.startsWith('n:') && rb.startsWith('n:')) {
        const alpha = Math.min(noteAlpha(from), noteAlpha(to))
        if (alpha < 0.02) continue
        const pa = layout.notes.get(from)!
        const pb = layout.notes.get(to)!
        ctx.beginPath()
        ctx.moveTo(sx(pa.x), sy(pa.y))
        ctx.lineTo(sx(pb.x), sy(pb.y))
        ctx.lineWidth = hot ? 1.8 : 1
        ctx.strokeStyle = hot ? withAlpha(col.accent, 0.9 * alpha) : withAlpha(col.edge, (focusNote ? 0.08 : 0.22) * alpha)
        ctx.stroke()
        continue
      }
      const key = ra < rb ? ra + '|' + rb : rb + '|' + ra
      const bundle = bundles.get(key) ?? { a: ra, b: rb, count: 0, hot: false }
      bundle.count++
      bundle.hot ||= hot
      bundles.set(key, bundle)
    }
    const point = (key: string) => {
      const id = key.slice(2)
      const p = key.startsWith('c:') ? layout.clusters.get(id)! : layout.notes.get(id)!
      const alpha = key.startsWith('c:') ? vis.get(id)! * shell(open.get(id)!) : noteAlpha(id)
      return { x: sx(p.x), y: sy(p.y), r: key.startsWith('c:') ? p.r * k : p.r * k, alpha }
    }
    for (const bundle of bundles.values()) {
      const a = point(bundle.a)
      const b = point(bundle.b)
      const alpha = Math.min(a.alpha, b.alpha)
      if (alpha < 0.02) continue
      const d = Math.hypot(b.x - a.x, b.y - a.y) || 1
      const ux = (b.x - a.x) / d
      const uy = (b.y - a.y) / d
      if (d < a.r + b.r) continue
      ctx.beginPath()
      ctx.moveTo(a.x + ux * a.r, a.y + uy * a.r)
      ctx.lineTo(b.x - ux * b.r, b.y - uy * b.r)
      ctx.lineWidth = Math.min(7, 1 + Math.log2(bundle.count) * 1.3)
      ctx.strokeStyle = bundle.hot ? withAlpha(col.accent, 0.85 * alpha) : withAlpha(col.edge, (focusNote ? 0.1 : 0.28) * alpha)
      ctx.stroke()
    }

    // 3. Closed folders as bubbles.
    const labels: Label[] = []
    for (const c of clustersByDepth) {
      const a = vis.get(c.id)! * shell(open.get(c.id)!)
      if (a < 0.01) continue
      const p = layout.clusters.get(c.id)!
      const x = sx(p.x)
      const y = sy(p.y)
      const r = p.r * k
      if (x + r < 0 || x - r > w || y + r < 0 || y - r > h) continue
      const isHover = hover.current?.kind === 'cluster' && hover.current.id === c.id
      const dimmed = focusNote && !marked.has(c.id)
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle = withAlpha(c.color, (isHover ? 0.3 : 0.18) * a * (dimmed ? 0.5 : 1))
      ctx.fill()
      ctx.lineWidth = marked.has(c.id) && focusNote ? 2.5 : 1.5
      ctx.strokeStyle = marked.has(c.id) && focusNote ? withAlpha(col.accent, a) : withAlpha(c.color, (isHover ? 0.9 : 0.6) * a)
      ctx.stroke()
      if (r > 16 && a > 0.05) {
        const size = Math.max(11, Math.min(20, r * 0.2))
        const font = `600 ${size}px Inter, "Segoe UI", system-ui, sans-serif`
        ctx.font = font
        const width = ctx.measureText(c.name).width
        const withCount = r > 34
        labels.push({
          x: x - width / 2,
          y: y - size,
          w: width,
          h: size * (withCount ? 2.2 : 1.4),
          priority: 300 + c.depth,
          paint: () => {
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.font = font
            ctx.fillStyle = withAlpha(col.text, a * (dimmed ? 0.5 : 1))
            ctx.fillText(c.name, x, y - (withCount ? size * 0.35 : 0))
            if (withCount) {
              ctx.font = `500 ${Math.max(10, size * 0.62)}px Inter, "Segoe UI", system-ui, sans-serif`
              ctx.fillStyle = withAlpha(col.dim, a * (dimmed ? 0.5 : 1))
              ctx.fillText(c.total === 1 ? '1 Notiz' : `${c.total} Notizen`, x, y + size * 0.75)
            }
          },
        })
      }
    }

    // 4. Notes.
    for (const note of vault.notes.values()) {
      if (isHidden(vault.home.get(note.id))) continue
      let a = noteAlpha(note.id)
      if (a < 0.01) continue
      const p = layout.notes.get(note.id)!
      const x = sx(p.x)
      const y = sy(p.y)
      // Dots stop growing at some point, otherwise deep zoom turns them into discs.
      const r = Math.min(MAX_DOT, Math.max(2, p.r * k))
      if (x + r < -40 || x - r > w + 40 || y + r < -20 || y - r > h + 20) continue
      const isFocus = note.id === focusNote
      const isNear = near?.has(note.id) ?? false
      if (focusNote && !isFocus && !isNear) a *= 0.25
      const color = vault.home.get(note.id)!.color
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle = withAlpha(isFocus ? col.accent : color, a)
      ctx.fill()
      if (note.aiDraft) {
        ctx.lineWidth = 1.5
        ctx.setLineDash([2, 2.5])
        ctx.strokeStyle = withAlpha('#c4b5fd', a)
        ctx.beginPath()
        ctx.arc(x, y, r + 3, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
      }
      if (isFocus || note.id === selected) {
        ctx.lineWidth = 2
        ctx.strokeStyle = withAlpha(col.accent, a)
        ctx.beginPath()
        ctx.arc(x, y, r + 4, 0, Math.PI * 2)
        ctx.stroke()
      }
      const labelAlpha = isFocus || isNear ? a : a * smoothstep(3.2, 6, p.r * k)
      if (labelAlpha > 0.03) {
        const font = `${isFocus ? 600 : 500} ${isFocus ? 13 : 12}px Inter, "Segoe UI", system-ui, sans-serif`
        ctx.font = font
        const width = ctx.measureText(note.title).width
        labels.push({
          x: x - width / 2 - 2,
          y: y + r + 4,
          w: width + 4,
          h: 16,
          priority: isFocus ? 1000 : isNear ? 500 : p.r,
          paint: () => {
            ctx.textAlign = 'center'
            ctx.textBaseline = 'top'
            ctx.font = font
            ctx.lineWidth = 3
            ctx.strokeStyle = withAlpha(col.bg, labelAlpha * 0.9)
            ctx.strokeText(note.title, x, y + r + 5)
            ctx.fillStyle = withAlpha(isFocus ? col.accent : col.text, labelAlpha)
            ctx.fillText(note.title, x, y + r + 5)
          },
        })
      }
    }

    // 5. Labels of open folders, at the top edge of their circle.
    for (const c of clustersByDepth) {
      const p = layout.clusters.get(c.id)!
      const r = p.r * k
      const a = vis.get(c.id)! * ring(open.get(c.id)!) * (1 - smoothstep(Math.max(w, h) * 0.9, Math.max(w, h) * 1.6, r))
      if (a < 0.02) continue
      const x = sx(p.x)
      const y = sy(p.y) - r + (c.depth === 1 ? 22 : 16)
      if (x < -200 || x > w + 200 || y < -20 || y > h + 20) continue
      const font = `${c.depth === 1 ? 700 : 600} ${c.depth === 1 ? 15 : 12}px Inter, "Segoe UI", system-ui, sans-serif`
      const text = c.depth === 1 ? c.name.toUpperCase() : c.name
      ctx.font = font
      const width = ctx.measureText(text).width
      labels.push({
        x: x - width / 2,
        y: y - 9,
        w: width,
        h: 18,
        priority: 400 - c.depth,
        paint: () => {
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.font = font
          ctx.fillStyle = withAlpha(c.color, a * 0.95)
          ctx.fillText(text, x, y)
        },
      })
    }

    // Labels by priority; one that would overlap an already placed label is left out.
    const placed: Label[] = []
    for (const label of labels.sort((a, b) => b.priority - a.priority)) {
      const clash = placed.some((o) => label.x < o.x + o.w && label.x + label.w > o.x && label.y < o.y + o.h && label.y + label.h > o.y)
      if (clash) continue
      placed.push(label)
      label.paint()
    }

    // Which folder the middle of the screen is in, for the breadcrumb.
    let focus = vault.root
    for (;;) {
      const deeper = focus.children.find((child) => {
        const p = layout.clusters.get(child.id)!
        return open.get(child.id)! >= 0.5 && Math.hypot(p.x - cx, p.y - cy) < p.r
      })
      if (!deeper) break
      focus = deeper
    }
    if (focus.id !== focusId.current) {
      focusId.current = focus.id
      props.current.onFocus(focus)
    }
  }, [isHidden])

  const redraw = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(draw)
  }, [draw])

  // ---- camera ----------------------------------------------------------------------------------------------------

  const fly = useCallback(
    (to: Camera, duration = 700) => {
      flight.current = { from: { ...camera.current }, to, start: performance.now(), duration }
      redraw()
    },
    [redraw],
  )

  const fitAllCamera = useCallback((): Camera => {
    const root = props.current.layout.clusters.get('')!
    const { w, h } = size.current
    return { x: root.x, y: root.y, k: (Math.min(w, h) * 0.47) / root.r }
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      fitAll: () => fly(fitAllCamera()),
      zoomBy: (factor: number) => {
        const c = camera.current
        fly({ ...c, k: Math.min(MAX_ZOOM, Math.max(fitAllCamera().k * 0.6, c.k * factor)) }, 280)
      },
      flyToCluster: (id: string) => {
        const p = props.current.layout.clusters.get(id)
        if (!p) return
        if (id === '') return fly(fitAllCamera())
        const { w, h } = size.current
        fly({ x: p.x, y: p.y, k: (Math.min(w, h) * 0.44) / p.r })
      },
      flyToNote: (id: string) => {
        const p = props.current.layout.notes.get(id)
        if (!p) return
        fly({ x: p.x, y: p.y, k: Math.max(camera.current.k, 2.2) }, 900)
      },
    }),
    [fly, fitAllCamera],
  )

  // ---- size, theme, first view -----------------------------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current!
    let first = true
    const observer = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      size.current = { w: rect.width, h: rect.height }
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
      if (first) {
        first = false
        camera.current = fitAllCamera()
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
      cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [fitAllCamera, redraw])

  useEffect(() => {
    redraw()
  }, [vault, layout, selected, hidden, redraw])

  // ---- pointer ---------------------------------------------------------------------------------------------------

  const hitTest = useCallback((px: number, py: number): Hover | null => {
    const { vault, layout } = props.current
    const { x: cx, y: cy, k } = camera.current
    const { w, h } = size.current
    const wx = (px - w / 2) / k + cx
    const wy = (py - h / 2) / k + cy
    const open = (c: Cluster) => openness(layout, c, k)
    const visible = (c: Cluster) => {
      for (let p = c.parent; p && p.depth > 0; p = p.parent) if (open(p) < 0.35) return false
      return true
    }
    let best: Hover | null = null
    let bestDistance = Infinity
    for (const note of vault.notes.values()) {
      const home = vault.home.get(note.id)!
      if (isHidden(home) || !visible(home) || open(home) < 0.35) continue
      const p = layout.notes.get(note.id)!
      const d = Math.hypot(p.x - wx, p.y - wy) * k
      if (d < Math.max(Math.min(MAX_DOT, p.r * k), 6) + 4 && d < bestDistance) {
        bestDistance = d
        best = { kind: 'note', id: note.id, x: (p.x - cx) * k + w / 2, y: (p.y - cy) * k + h / 2 + Math.min(MAX_DOT, Math.max(p.r * k, 2)) }
      }
    }
    if (best) return best
    let deepest: Cluster | null = null
    for (const c of vault.clusters.values()) {
      if (c.depth === 0 || isHidden(c) || !visible(c) || open(c) >= 0.5) continue
      const p = layout.clusters.get(c.id)!
      if (Math.hypot(p.x - wx, p.y - wy) < p.r && (!deepest || c.depth > deepest.depth)) deepest = c
    }
    if (!deepest) return null
    const p = layout.clusters.get(deepest.id)!
    return { kind: 'cluster', id: deepest.id, x: (p.x - cx) * k + w / 2, y: (p.y - cy) * k + h / 2 + p.r * k }
  }, [isHidden])

  useEffect(() => {
    const canvas = canvasRef.current!
    const pointers = new Map<number, { x: number; y: number }>()
    let moved = 0
    let pinch: { distance: number; k: number } | null = null
    let lastClick = { id: '', time: 0 }

    const local = (e: PointerEvent | WheelEvent) => {
      const rect = canvas.getBoundingClientRect()
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }

    const setHover = (next: Hover | null) => {
      const current = hover.current
      if (current?.id === next?.id && current?.kind === next?.kind) return
      hover.current = next
      canvas.style.cursor = next ? 'pointer' : 'grab'
      props.current.onHover(next)
      redraw()
    }

    const zoomAt = (px: number, py: number, factor: number) => {
      const c = camera.current
      const { w, h } = size.current
      const k = Math.min(MAX_ZOOM, Math.max(fitAllCamera().k * 0.6, c.k * factor))
      const wx = (px - w / 2) / c.k + c.x
      const wy = (py - h / 2) / c.k + c.y
      camera.current = { k, x: wx - (px - w / 2) / k, y: wy - (py - h / 2) / k }
      flight.current = null
      redraw()
    }

    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId)
      pointers.set(e.pointerId, local(e))
      moved = 0
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), k: camera.current.k }
      }
    }

    const onMove = (e: PointerEvent) => {
      const p = local(e)
      const previous = pointers.get(e.pointerId)
      if (!previous) {
        setHover(hitTest(p.x, p.y))
        return
      }
      pointers.set(e.pointerId, p)
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()]
        const distance = Math.hypot(a.x - b.x, a.y - b.y)
        zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, (pinch.k * (distance / pinch.distance)) / camera.current.k)
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
      if (moved > 3 || pointers.size > 0) return
      const hit = hitTest(p.x, p.y)
      const { onSelect, onOpen } = props.current
      if (!hit) {
        onSelect(null)
        return
      }
      if (hit.kind === 'cluster') {
        const layoutCluster = props.current.layout.clusters.get(hit.id)!
        const { w, h } = size.current
        fly({ x: layoutCluster.x, y: layoutCluster.y, k: (Math.min(w, h) * 0.44) / layoutCluster.r })
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
      setHover(null)
    }

    const onLeave = () => {
      if (pointers.size === 0) setHover(null)
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('pointerleave', onLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [fitAllCamera, fly, hitTest, redraw])

  return <canvas ref={canvasRef} className="block h-full w-full touch-none" style={{ cursor: 'grab' }} aria-label={i18n.t('graph.canvas')} />
})
