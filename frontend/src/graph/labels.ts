/**
 * Labels on the 2D canvas above the WebGL one: the most important first, and a label that would overlap one already
 * placed is left out. A grid of cells keeps the overlap check quick when a few thousand notes are in view.
 */

import { SYMBOLS, type SymbolName } from '../lib/symbols'

export type LabelItem = {
  /** Middle of the text. */
  x: number
  /** Top of the text for `baseline: 'top'`, middle for `'middle'`. */
  y: number
  text: string
  /** A second, smaller line under the first (a closed group's note count). */
  sub?: string
  size: number
  weight: number
  color: string
  subColor?: string
  alpha: number
  baseline: 'top' | 'middle'
  priority: number
  /** An outline in the page colour, for text on top of lines. */
  halo?: boolean
  /** Wider than this, the text breaks into lines (at " · " first, then at spaces). */
  maxWidth?: number
  /** A symbol of `lib/symbols` drawn above the text (a space or folder with one chosen by hand). */
  icon?: string | null
  /** Its colour: the space's or folder's, where the text may be in another. */
  iconColor?: string
}

/**
 * Which name of a closed bubble goes first where names would overlap. Bigger bubbles first: their names say more, and
 * a small neighbour gives way. A bubble that is already opening (its name in the middle fading out, the one on top
 * fading in) gives way to every closed bubble inside it, or its fading name hides theirs.
 */
export function closedLabelPriority(radius: number, opening: number): number {
  return (opening > 0.02 ? 200 : 300) + Math.min(99, radius / 10)
}

type Box = { x0: number; y0: number; x1: number; y1: number }

const CELL = 64
const FONT = 'Inter, "Segoe UI", system-ui, sans-serif'

export function font(size: number, weight: number): string {
  return `${weight} ${size}px ${FONT}`
}

/** Lines of at most `maxWidth`, broken at " · " (the words of a topic) or else at spaces; a single long word stays. */
export function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (ctx.measureText(text).width <= maxWidth) return [text]
  const parts = text.includes(' · ') ? text.split(' · ') : text.split(' ')
  const glue = text.includes(' · ') ? ' · ' : ' '
  const lines: string[] = []
  let line = ''
  for (const part of parts) {
    const next = line ? line + glue + part : part
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line)
      line = part
    } else line = next
  }
  if (line) lines.push(line)
  return lines.slice(0, 3)
}

/** Draws the labels that fit and returns how many were drawn. */
export function drawLabels(ctx: CanvasRenderingContext2D, items: LabelItem[], background: string, width: number, height: number): number {
  const grid = new Map<number, Box[]>()
  const cells = (box: Box) => {
    const keys: number[] = []
    for (let cx = Math.floor(box.x0 / CELL); cx <= Math.floor(box.x1 / CELL); cx++)
      for (let cy = Math.floor(box.y0 / CELL); cy <= Math.floor(box.y1 / CELL); cy++) keys.push(cx * 100003 + cy)
    return keys
  }
  let drawn = 0
  items.sort((a, b) => b.priority - a.priority)
  for (const item of items) {
    if (item.alpha < 0.03 || !item.text) continue
    ctx.font = font(item.size, item.weight)
    const lines = item.maxWidth ? wrap(ctx, item.text, item.maxWidth) : [item.text]
    const w = Math.max(...lines.map((line) => ctx.measureText(line).width))
    const extra = (lines.length - 1) * item.size * 1.15
    const subSize = Math.max(10, item.size * 0.62)
    let subW = 0
    if (item.sub) {
      ctx.font = font(subSize, 500)
      subW = ctx.measureText(item.sub).width
    }
    const h = item.size * (item.sub ? 2.2 : 1.35) + extra
    const top = item.baseline === 'top' ? item.y : item.y - (item.sub ? item.size * 0.95 : item.size * 0.6) - extra / 2
    const half = Math.max(w, subW) / 2 + 2
    const paths = item.icon ? SYMBOLS[item.icon as SymbolName] : undefined
    const iconSize = Math.round(item.size * 1.25)
    const box = { x0: item.x - half, y0: top - (paths ? iconSize + 3 : 0), x1: item.x + half, y1: top + h }
    if (box.x1 < 0 || box.x0 > width || box.y1 < 0 || box.y0 > height) continue
    const keys = cells(box)
    const clash = keys.some((key) =>
      (grid.get(key) ?? []).some((o) => box.x0 < o.x1 && box.x1 > o.x0 && box.y0 < o.y1 && box.y1 > o.y0),
    )
    if (clash) continue
    for (const key of keys) {
      const list = grid.get(key)
      if (list) list.push(box)
      else grid.set(key, [box])
    }
    ctx.globalAlpha = Math.min(1, item.alpha)
    if (paths) {
      ctx.save()
      ctx.translate(item.x - iconSize / 2, top - iconSize - 3)
      ctx.scale(iconSize / 24, iconSize / 24)
      ctx.lineWidth = 1.8
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.strokeStyle = item.iconColor ?? item.color
      ctx.fillStyle = item.iconColor ?? item.color
      for (const path of paths as { d: string; fill?: boolean }[]) {
        const shape = new Path2D(path.d)
        if (path.fill) ctx.fill(shape)
        else ctx.stroke(shape)
      }
      ctx.restore()
    }
    ctx.textAlign = 'center'
    ctx.font = font(item.size, item.weight)
    const lineY = (item.baseline === 'top' ? item.y : item.sub ? item.y - item.size * 0.35 : item.y) - (item.baseline === 'top' ? 0 : extra / 2)
    ctx.textBaseline = item.baseline
    lines.forEach((line, index) => {
      const y = lineY + index * item.size * 1.15
      if (item.halo) {
        ctx.lineWidth = 3
        ctx.strokeStyle = background
        ctx.strokeText(line, item.x, y)
      }
      ctx.fillStyle = item.color
      ctx.fillText(line, item.x, y)
    })
    if (item.sub) {
      ctx.font = font(subSize, 500)
      ctx.fillStyle = item.subColor ?? item.color
      ctx.textBaseline = 'middle'
      ctx.fillText(item.sub, item.x, item.y + item.size * 0.75 + extra / 2)
    }
    drawn++
  }
  ctx.globalAlpha = 1
  return drawn
}
