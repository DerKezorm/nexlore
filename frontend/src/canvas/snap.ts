/**
 * Snapping while a card moves or grows, as in nexcanvas: the edges and the middle of what moves come to the edges and
 * middles of the other cards when they are close. Close is counted on the screen (`SNAP_PX`), so it feels the same at
 * every zoom. Each axis snaps on its own, to the nearest line; the lines that then match are the guides to draw.
 */

export const SNAP_PX = 7

type Box = { x: number; y: number; width: number; height: number }

export type Snapped = { dx: number; dy: number; guidesX: number[]; guidesY: number[] }

const linesX = (box: Box) => [box.x, box.x + box.width / 2, box.x + box.width]
const linesY = (box: Box) => [box.y, box.y + box.height / 2, box.y + box.height]

/**
 * How far to shift so that one of `own` (positions on the canvas: for a move the left edge, middle and right edge of
 * the moving box; for growing only the edge that moves) meets a line of `others`. `zoom`: the canvas's scale.
 */
export function snap(own: { x: number[]; y: number[] }, others: readonly Box[], zoom: number): Snapped {
  const reach = SNAP_PX / zoom
  let bestX: number | null = null
  let bestY: number | null = null
  for (const other of others) {
    for (const a of own.x) for (const b of linesX(other)) if (Math.abs(b - a) <= reach && (bestX === null || Math.abs(b - a) < Math.abs(bestX))) bestX = b - a
    for (const a of own.y) for (const b of linesY(other)) if (Math.abs(b - a) <= reach && (bestY === null || Math.abs(b - a) < Math.abs(bestY))) bestY = b - a
  }
  const dx = bestX ?? 0
  const dy = bestY ?? 0
  const guidesX = new Set<number>()
  const guidesY = new Set<number>()
  // A line that matches now was in reach: without a snap on an axis there is none to draw there.
  for (const other of others) {
    for (const a of own.x) for (const b of linesX(other)) if (Math.abs(a + dx - b) < 0.5) guidesX.add(b)
    for (const a of own.y) for (const b of linesY(other)) if (Math.abs(a + dy - b) < 0.5) guidesY.add(b)
  }
  return { dx, dy, guidesX: [...guidesX], guidesY: [...guidesY] }
}

/** The lines of a box that moves whole. */
export function moving(box: Box): { x: number[]; y: number[] } {
  return { x: linesX(box), y: linesY(box) }
}
