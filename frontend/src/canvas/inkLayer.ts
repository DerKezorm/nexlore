/**
 * The pen's layer over a canvas: one drawing (an `.svg` with its strokes, `lib/ink.ts`) in the canvas's attachment
 * folder, on the canvas as a file card with `"nexloreInk": true`. Its strokes are in the canvas's own units, one to
 * one, and the card's box is the box the server writes as the file's `viewBox`: Obsidian (or any program that knows
 * JSON Canvas) shows the drawing as a picture exactly where the strokes lie; one that drops the field still has an
 * ordinary picture card. nexlore draws it over every card instead, never as a card of its own.
 *
 * Here without a browser: which card is the layer, how React Flow's view and the drawing surface's view turn into each
 * other, the box of the card, and which strokes go along when cards are moved.
 */
import { EMPTY_BOX, PAD, reach, type InkStroke, type Placement } from '../lib/ink'
import { makeNode, type Canvas, type CanvasNode } from './model'

/** The field that marks the layer's card. */
export const INK_FIELD = 'nexloreInk'

type Box = { x: number; y: number; width: number; height: number }
/** React Flow's view: the shift in pixels and the zoom. */
export type Viewport = { x: number; y: number; zoom: number }

export function isInkLayer(node: CanvasNode): boolean {
  return node.type === 'file' && node[INK_FIELD] === true && typeof node.file === 'string'
}

/** The layer's card: the first one marked (a second, from a copy in another program, is an ordinary picture). */
export function inkLayerOf(canvas: Canvas): CanvasNode | undefined {
  return canvas.nodes.find(isInkLayer)
}

/** The cards without the layer: what React Flow draws, what snaps, what a group carries. */
export function cardsOf(nodes: readonly CanvasNode[]): CanvasNode[] {
  const layer = nodes.find(isInkLayer)
  return layer ? nodes.filter((node) => node !== layer) : [...nodes]
}

// --- The two views -------------------------------------------------------------------------------------------------

/**
 * React Flow's view as the drawing surface's: a pixel `p` of the canvas shows the point `(p - shift) / zoom`, so the
 * surface's top left lies at `-shift / zoom`, with as many pixels per unit as the zoom.
 */
export function placementOf(viewport: Viewport): Placement {
  return { x: -viewport.x / viewport.zoom, y: -viewport.y / viewport.zoom, z: viewport.zoom }
}

export function viewportOf(place: Placement): Viewport {
  return { x: -place.x * place.z, y: -place.y * place.z, zoom: place.z }
}

/**
 * A view the surface asked for, kept within the canvas's zoom: the surface zooms closer (10) than the canvas (4). The
 * point that stood still between `before` and `next` (the pointer under a zoom) stays where it was.
 */
export function clampedPlacement(before: Placement, next: Placement, least: number, most: number): Placement {
  const z = Math.min(most, Math.max(least, next.z))
  if (z === next.z) return next
  if (next.z === before.z) return { ...next, z }
  // The fixed point of the zoom: (p - before.x) * before.z = (p - next.x) * next.z.
  const px = (next.x * next.z - before.x * before.z) / (next.z - before.z)
  const py = (next.y * next.z - before.y * before.z) / (next.z - before.z)
  const sx = (px - before.x) * before.z
  const sy = (py - before.y) * before.z
  return { x: px - sx / z, y: py - sy / z, z }
}

// --- The card's box --------------------------------------------------------------------------------------------------

/**
 * The box of the layer's card: every stroke with the room its line takes plus the file's margin, in whole units,
 * rounded outwards, exactly as the server writes the `viewBox` (`services/ink._box`); the box of an empty drawing for
 * none. Whole units as JSON Canvas wants them, and the picture fills the card without being scaled.
 */
export function layerBox(strokes: readonly InkStroke[]): Box {
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
  if (left > right) return { x: EMPTY_BOX.x, y: EMPTY_BOX.y, width: EMPTY_BOX.w, height: EMPTY_BOX.h }
  const x = Math.floor(left - PAD)
  const y = Math.floor(top - PAD)
  return { x, y, width: Math.ceil(right + PAD) - x, height: Math.ceil(bottom + PAD) - y }
}

export function sameBox(node: Box, box: Box): boolean {
  return node.x === box.x && node.y === box.y && node.width === box.width && node.height === box.height
}

/** The layer's card for a drawing at `file` (as the canvas writes it): a file card, marked, its box the strokes'. */
export function makeLayer(canvas: Canvas, file: string, strokes: readonly InkStroke[]): CanvasNode {
  const node = makeNode(canvas, { type: 'file', file }, layerBox(strokes))
  node[INK_FIELD] = true
  return node
}

// --- Strokes that go along -------------------------------------------------------------------------------------------

/**
 * The strokes that go along when cards in `boxes` are moved: those lying wholly on the cards, every point inside one of
 * them (a note written on a picture, an arrow from one moved card to another). A stroke with a point beside them
 * stays. By their place in `strokes`.
 */
export function carriedStrokes(strokes: readonly InkStroke[], boxes: readonly Box[]): number[] {
  if (!boxes.length) return []
  const inside = (x: number, y: number) => boxes.some((box) => x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height)
  const picked: number[] = []
  strokes.forEach((stroke, index) => {
    if (stroke.pts.length && stroke.pts.every(([x, y]) => inside(x, y))) picked.push(index)
  })
  return picked
}
