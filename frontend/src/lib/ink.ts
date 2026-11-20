/**
 * Drawings: an `.svg` in the vault with its strokes inside (`data-nexlore-ink="1"`), read and written by the server
 * (`/api/ink`). This is what the drawing surface works with, without a browser: the data as it comes, the outline of
 * a pen stroke with its pressure, the box around everything and the view that fits it, erasing whole strokes or
 * parts, the lasso, moving.
 *
 * The surface is endless: coordinates are free (negative too). A view is its top left corner in drawing units and
 * `z`, pixels per unit; a block in a note keeps its height `h` in pixels with it.
 *
 * Nothing is ever drawn from the SVG's text: the page draws from the strokes, so a script smuggled into a file never
 * runs. Fields this version does not know (later versions, the recognised text) go back to the server untouched.
 */

export type InkTool = 'pen' | 'marker'
/** x, y in drawing units, pressure 0..1. */
export type InkPoint = [number, number, number]
export type InkStroke = { tool: InkTool; color: string; size: number; pts: InkPoint[]; [field: string]: unknown }
export type InkBackground = 'none' | 'lines' | 'grid' | 'dots'
/** The view kept with the drawing (D9): top left in drawing units, pixels per unit, the block's height in pixels. */
export type InkView = { x: number; y: number; z: number; h: number }
export type Ink = { v: number; bg: InkBackground; strokes: InkStroke[]; view?: InkView; [field: string]: unknown }
export type Box = { x: number; y: number; w: number; h: number }
/** Where a surface looks: top left in drawing units and pixels per unit. */
export type Placement = { x: number; y: number; z: number }
export type Point = [number, number]

/** What the server takes (the interface, version 1). */
export const LIMITS = {
  strokes: 20_000,
  points: 10_000,
  coordinate: 999_999,
  minSize: 0.5,
  maxSize: 64,
  minZoom: 0.05,
  maxZoom: 10,
  minHeight: 80,
  maxHeight: 2000,
} as const

/** The box of an empty drawing, as the server writes its `viewBox`. */
export const EMPTY_BOX: Box = { x: 0, y: 0, w: 680, h: 220 }
/** Room around what is drawn. */
export const PAD = 24
/** The colour that follows light and dark: the theme's text colour. */
export const INK = 'ink'
/** A highlighter in ink would hide what it marks: it is yellow then. */
export const MARKER_COLOR = '#facc15'
export const BACKGROUNDS: readonly InkBackground[] = ['none', 'lines', 'grid', 'dots']
export const COLORS: readonly string[] = [INK, '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#facc15']
export const SIZES: readonly number[] = [2, 4, 8]
/** How much of a highlighter shows through. */
export const MARKER_OPACITY = 0.38

export const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

// --- Reading what the server sends ------------------------------------------------------------------------------------

function readPoint(raw: unknown): InkPoint | null {
  if (!Array.isArray(raw) || !finite(raw[0]) || !finite(raw[1])) return null
  const pressure = finite(raw[2]) ? clamp(raw[2], 0, 1) : 0.5
  return [clamp(raw[0], -LIMITS.coordinate, LIMITS.coordinate), clamp(raw[1], -LIMITS.coordinate, LIMITS.coordinate), pressure]
}

function readStroke(raw: unknown): InkStroke[] {
  if (!isRecord(raw) || !Array.isArray(raw.pts)) return []
  const pts = raw.pts.map(readPoint).filter((point): point is InkPoint => point !== null).slice(0, LIMITS.points)
  if (!pts.length) return []
  const color = typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : INK
  return [{ ...raw, tool: raw.tool === 'marker' ? 'marker' : 'pen', color, size: finite(raw.size) ? clamp(raw.size, LIMITS.minSize, LIMITS.maxSize) : 4, pts }]
}

/** A view as the file keeps it, or null when it is missing or makes no sense. */
export function readView(raw: unknown): InkView | null {
  if (!isRecord(raw) || !finite(raw.x) || !finite(raw.y) || !finite(raw.z) || !finite(raw.h)) return null
  return {
    x: clamp(raw.x, -LIMITS.coordinate, LIMITS.coordinate),
    y: clamp(raw.y, -LIMITS.coordinate, LIMITS.coordinate),
    z: clamp(raw.z, LIMITS.minZoom, LIMITS.maxZoom),
    h: Math.round(clamp(raw.h, LIMITS.minHeight, LIMITS.maxHeight)),
  }
}

/**
 * The drawing as the server sent it (`ink` of `/api/ink`), made safe to draw. Fields not known here (`text`,
 * `words`, later ones) stay as they came, to go back with the next save.
 */
export function readInk(raw: unknown): Ink {
  const source = isRecord(raw) ? raw : {}
  const strokes = (Array.isArray(source.strokes) ? source.strokes : []).flatMap(readStroke).slice(0, LIMITS.strokes)
  const bg = BACKGROUNDS.includes(source.bg as InkBackground) ? (source.bg as InkBackground) : 'none'
  const ink: Ink = { ...source, v: finite(source.v) ? source.v : 1, bg, strokes }
  const view = readView(source.view)
  if (view) ink.view = view
  else delete ink.view
  return ink
}

/**
 * What goes back to the server: what came (with every field this version does not know), with the strokes, the
 * background and the view of now. `view` null leaves the drawing without one (shown whole).
 */
export function composeInk(loaded: Ink, strokes: InkStroke[], bg: InkBackground, view: InkView | null): Ink {
  const next: Ink = { ...loaded, v: loaded.v || 1, bg, strokes }
  if (view) next.view = view
  else delete next.view
  return next
}

// --- Boxes and views ---------------------------------------------------------------------------------------------------

/** How far a stroke reaches beside its points: a highlighter is three times as wide as its size. */
export function reach(stroke: Pick<InkStroke, 'tool' | 'size'>): number {
  return stroke.tool === 'marker' ? stroke.size * 1.5 : stroke.size * 0.7
}

/** The box around every stroke, with `pad` around it; an empty drawing has the size the server gives it. */
export function bounds(strokes: readonly InkStroke[], pad = PAD): Box {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const stroke of strokes) {
    const r = reach(stroke)
    for (const [x, y] of stroke.pts) {
      left = Math.min(left, x - r)
      top = Math.min(top, y - r)
      right = Math.max(right, x + r)
      bottom = Math.max(bottom, y + r)
    }
  }
  if (left > right) return { ...EMPTY_BOX }
  return { x: left - pad, y: top - pad, w: right - left + 2 * pad, h: bottom - top + 2 * pad }
}

/** The view that shows `box` whole in `width` by `height` pixels, centred, never closer than `most`. */
export function fitTo(box: Box, width: number, height: number, pad = 8, most = 2.5): Placement {
  const room = (size: number) => Math.max(1, size - 2 * pad)
  const z = clamp(Math.min(room(width) / Math.max(box.w, 1), room(height) / Math.max(box.h, 1), most), LIMITS.minZoom, LIMITS.maxZoom)
  return { x: box.x + box.w / 2 - width / 2 / z, y: box.y + box.h / 2 - height / 2 / z, z }
}

/** Zoomed by `factor` around the pixel (`px`, `py`) of the surface: what is under the pointer stays there. */
export function zoomAt(place: Placement, factor: number, px: number, py: number): Placement {
  const z = clamp(place.z * factor, LIMITS.minZoom, LIMITS.maxZoom)
  const atX = place.x + px / place.z
  const atY = place.y + py / place.z
  return { x: atX - px / z, y: atY - py / z, z }
}

/** Moved by pixels on the screen (a drag to the right shows what lies left). */
export function panBy(place: Placement, dx: number, dy: number): Placement {
  return { x: place.x - dx / place.z, y: place.y - dy / place.z, z: place.z }
}

/** The pixel (`px`, `py`) of a surface as a point of the drawing. */
export function toDrawing(place: Placement, px: number, py: number): Point {
  return [place.x + px / place.z, place.y + py / place.z]
}

export function viewBoxOf(place: Placement, width: number, height: number): string {
  const round = (value: number) => Math.round(value * 100) / 100
  return `${round(place.x)} ${round(place.y)} ${round(width / place.z)} ${round(height / place.z)}`
}

/** The height a block gets for a drawing shown whole at `width`: as the drawing is shaped, within reason. */
export function fittedHeight(box: Box, width: number): number {
  return Math.round(clamp((width * box.h) / Math.max(box.w, 1), 120, 560))
}

/**
 * What a block in a note shows (D9): the view kept with the drawing, else the whole drawing fitted to the block's
 * width. `whole` asks for the whole drawing at the height the block has.
 */
export function blockPlacement(ink: Pick<Ink, 'strokes' | 'view'>, width: number, whole = false): Placement & { h: number } {
  const box = bounds(ink.strokes)
  if (ink.view && !whole) return { ...ink.view }
  const h = ink.view?.h ?? fittedHeight(box, width)
  return { ...fitTo(box, width, h), h }
}

/** The same view, to the precision a file needs; null when nothing differs from `before` worth writing. */
export function changedView(before: InkView | undefined, next: InkView): InkView | null {
  const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places
  const kept = readView({ x: round(next.x, 1), y: round(next.y, 1), z: round(next.z, 4), h: next.h })
  if (!kept) return null
  if (before && before.x === kept.x && before.y === kept.y && before.z === kept.z && before.h === kept.h) return null
  return kept
}

/**
 * Writing on at the edge of a surface pushes the picture along (only where the surface moves): how far, in drawing
 * units, for a pointer at (`x`, `y`) in a surface of `width` by `height` pixels.
 */
export function followEdge(x: number, y: number, width: number, height: number, z: number, margin = 28, step = 6): Point {
  const by = step / z
  const dx = x > width - margin ? by : x < margin ? -by : 0
  const dy = y > height - margin ? by : y < margin ? -by : 0
  return [dx, dy]
}

// --- Strokes as shapes -------------------------------------------------------------------------------------------------

/** How wide a pen is at a point with that pressure. */
export function widthAt(size: number, pressure: number): number {
  return size * (0.35 + 0.95 * pressure)
}

/**
 * The pressure of a new point. A pen says it; a mouse has none, so it comes from the speed (fast is thinner),
 * eased with the last point.
 */
export function pressureOf(kind: string, pressure: number, last: InkPoint | null, at: Point, z: number): number {
  if (kind === 'pen' && pressure > 0) return clamp(pressure, 0, 1)
  if (!last) return 0.55
  const speed = Math.hypot(at[0] - last[0], at[1] - last[1]) * z
  return clamp(last[2] * 0.7 + (1 - (Math.min(speed, 18) / 18) * 0.75) * 0.3, 0.25, 0.95)
}

/** A path to draw: `filled` for a pen's outline, else a line `width` wide (a highlighter). */
export type StrokeShape = { d: string; filled: boolean; width: number }

const n1 = (value: number) => String(Math.round(value * 10) / 10)
const at = (point: readonly number[]) => `${n1(point[0])} ${n1(point[1])}`

function dot(x: number, y: number, r: number): string {
  return `M${n1(x - r)} ${n1(y)}a${n1(r)} ${n1(r)} 0 1 0 ${n1(2 * r)} 0a${n1(r)} ${n1(r)} 0 1 0 ${n1(-2 * r)} 0Z`
}

/**
 * The shape of a stroke. A pen is a filled outline: both edges along the smoothed points, as wide as the pressure at
 * each, round at both ends; a single point is a dot. A highlighter is a plain round line, three times its size.
 */
export function strokeShape(stroke: Pick<InkStroke, 'tool' | 'size' | 'pts'>): StrokeShape {
  const points = stroke.pts
  const count = points.length
  if (!count) return { d: '', filled: true, width: 0 }
  if (stroke.tool === 'marker') {
    const d = count === 1 ? `M${at(points[0])}l0.1 0` : 'M' + points.map(at).join('L')
    return { d, filled: false, width: stroke.size * 3 }
  }
  const half = (index: number) => widthAt(stroke.size, points[index][2]) / 2
  if (count === 1) return { d: dot(points[0][0], points[0][1], half(0) + 0.4), filled: true, width: 0 }
  // Each point a little towards its neighbours: the edges do not jitter with the hand. The ends stay where they are.
  const smooth = points.map((point, index) => {
    if (index === 0 || index === count - 1) return [point[0], point[1]]
    const before = points[Math.max(0, index - 1)]
    const after = points[Math.min(count - 1, index + 1)]
    return [(before[0] + 2 * point[0] + after[0]) / 4, (before[1] + 2 * point[1] + after[1]) / 4]
  })
  const left: number[][] = []
  const right: number[][] = []
  for (let index = 0; index < count; index++) {
    const before = smooth[Math.max(0, index - 1)]
    const after = smooth[Math.min(count - 1, index + 1)]
    let dx = after[0] - before[0]
    let dy = after[1] - before[1]
    const length = Math.hypot(dx, dy) || 1
    dx /= length
    dy /= length
    const r = half(index)
    left.push([smooth[index][0] - dy * r, smooth[index][1] + dx * r])
    right.push([smooth[index][0] + dy * r, smooth[index][1] - dx * r])
  }
  const end = n1(half(count - 1))
  const start = n1(half(0))
  const d =
    `M${at(left[0])}L${left.slice(1).map(at).join('L')}` +
    `A${end} ${end} 0 0 0 ${at(right[count - 1])}` +
    (count > 1 ? `L${right.slice(0, -1).reverse().map(at).join('L')}` : '') +
    `A${start} ${start} 0 0 0 ${at(left[0])}Z`
  return { d, filled: true, width: 0 }
}

/** A point as a file keeps it: tenths of a unit, hundredths of pressure, within the limits. */
export function keptPoint(x: number, y: number, pressure: number): InkPoint {
  const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places
  return [
    round(clamp(x, -LIMITS.coordinate, LIMITS.coordinate), 1),
    round(clamp(y, -LIMITS.coordinate, LIMITS.coordinate), 1),
    round(clamp(pressure, 0, 1), 2),
  ]
}

// --- Erasing, choosing, moving -----------------------------------------------------------------------------------------

/** How far `p` is from the segment `a`–`b`. */
export function distanceToSegment(p: Point, a: readonly number[], b: readonly number[]): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const length = dx * dx + dy * dy
  const t = length ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length, 0, 1) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

/** Half of how wide a stroke is drawn (a pen at middle pressure). */
export function halfWidth(stroke: Pick<InkStroke, 'tool' | 'size'>): number {
  return stroke.tool === 'marker' ? stroke.size * 1.5 : stroke.size / 2
}

/** Whether an eraser of radius `r` at `p` touches the stroke anywhere (along its lines, as wide as it is drawn). */
export function touches(stroke: InkStroke, p: Point, r: number): boolean {
  const near = r + halfWidth(stroke)
  const points = stroke.pts
  if (points.length === 1) return Math.hypot(p[0] - points[0][0], p[1] - points[0][1]) < near
  for (let index = 1; index < points.length; index++) if (distanceToSegment(p, points[index - 1], points[index]) < near) return true
  return false
}

/** The whole strokes the eraser touches go. The same array back when it touched none. */
export function eraseWhole(strokes: InkStroke[], p: Point, r: number): InkStroke[] {
  const kept = strokes.filter((stroke) => !touches(stroke, p, r))
  return kept.length === strokes.length ? strokes : kept
}

/**
 * Only what the eraser passes over goes: the points under it, a stroke falling apart into the pieces left. The same
 * array back when it touched none.
 */
export function erasePart(strokes: InkStroke[], p: Point, r: number): InkStroke[] {
  let hit = false
  const out: InkStroke[] = []
  for (const stroke of strokes) {
    const near = r + halfWidth(stroke)
    if (!stroke.pts.some((point) => Math.hypot(p[0] - point[0], p[1] - point[1]) < near)) {
      out.push(stroke)
      continue
    }
    hit = true
    let piece: InkPoint[] = []
    for (const point of stroke.pts) {
      if (Math.hypot(p[0] - point[0], p[1] - point[1]) < near) {
        if (piece.length) out.push({ ...stroke, pts: piece })
        piece = []
      } else piece.push(point)
    }
    if (piece.length) out.push({ ...stroke, pts: piece })
  }
  return hit ? out.slice(0, LIMITS.strokes) : strokes
}

/** Whether `p` lies inside the polygon (even-odd). */
export function inPolygon(p: Point, polygon: readonly Point[]): boolean {
  let inside = false
  for (let index = 0, before = polygon.length - 1; index < polygon.length; before = index++) {
    const a = polygon[index]
    const b = polygon[before]
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}

/** The strokes a lasso catches: more than half of their points inside it. */
export function lassoPick(strokes: readonly InkStroke[], polygon: readonly Point[]): number[] {
  if (polygon.length < 3) return []
  const picked: number[] = []
  strokes.forEach((stroke, index) => {
    const inside = stroke.pts.filter((point) => inPolygon([point[0], point[1]], polygon)).length
    if (inside > stroke.pts.length / 2) picked.push(index)
  })
  return picked
}

/** The chosen strokes moved by (`dx`, `dy`) units; the others stay the same objects. */
export function moveStrokes(strokes: InkStroke[], picked: readonly number[], dx: number, dy: number): InkStroke[] {
  const chosen = new Set(picked)
  return strokes.map((stroke, index) =>
    chosen.has(index) ? { ...stroke, pts: stroke.pts.map(([x, y, p]) => keptPoint(x + dx, y + dy, p)) } : stroke,
  )
}

export function removeStrokes(strokes: InkStroke[], picked: readonly number[]): InkStroke[] {
  const chosen = new Set(picked)
  return strokes.filter((_, index) => !chosen.has(index))
}

/** The box around the chosen strokes, `pad` units around it; null for none. */
export function pickedBox(strokes: readonly InkStroke[], picked: readonly number[], pad = 8): Box | null {
  const chosen = picked.map((index) => strokes[index]).filter(Boolean)
  if (!chosen.length) return null
  const box = bounds(chosen, 0)
  return { x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad }
}

export function inBox(p: Point, box: Box | null): boolean {
  return !!box && p[0] >= box.x && p[0] <= box.x + box.w && p[1] >= box.y && p[1] <= box.y + box.h
}

// --- A new drawing opens at once -----------------------------------------------------------------------------------------

/** Drawings just made from the note: their block opens for drawing as soon as it shows. */
const toOpen = new Set<string>()

export function askToDraw(path: string): void {
  toOpen.add(path)
}

/** Whether the block of `path` was asked to open for drawing; asked once only. */
export function takeDrawRequest(path: string): boolean {
  return toOpen.delete(path)
}
