/**
 * The way a line takes on the canvas: out of its card at right angles, around every card in between, into the other
 * card at right angles, the corners rounded. Obsidian draws a curve from side to side that runs under any card in
 * its way; nexlore goes around. Only the drawing: the file keeps the two sides, so Obsidian shows the same line as
 * its curve.
 *
 * A search over a sparse grid: the lines a margin off every card's edges, the two ends, and the middles between
 * them. Shortest way, each bend costing extra, never back on itself, and running along a card's margin a little
 * dearer than down the middle between two cards. Cards away from both ends are left out until the way found runs
 * through one. No way (cards lying on each other, an end inside another card): null, and the
 * line is drawn as the curve.
 */
import type { Side } from './model'

export type Box = { x: number; y: number; width: number; height: number }
export type Point = { x: number; y: number }

/** How far a line keeps off the cards it goes around; tighter where cards stand closer than this. */
export const GAP = 24
/** What a bend costs, in canvas pixels of way: a little longer but straighter wins. */
const BEND = 48
/** What running along a card's margin costs on top, for each pixel: a bend between two cards comes halfway. */
const HUG = 0.25
/** How round a corner is at most. */
export const RADIUS = 10
/** More cards near one line than this, and it is left to the curve (a search would hold up the drawing). */
const MANY = 150
/** Nor more grid points than this. */
const MANY_POINTS = 60_000

type Rect = { left: number; top: number; right: number; bottom: number }

// Directions as numbers, so that the opposite of d is (d + 2) % 4.
const TOP = 0
const RIGHT = 1
const BOTTOM = 2
const LEFT = 3
const DX = [0, 1, 0, -1]
const DY = [-1, 0, 1, 0]
const OUT: Record<Side, number> = { top: TOP, right: RIGHT, bottom: BOTTOM, left: LEFT }

/** The middle of a card's side: where a line leaves or ends. */
export function port(box: Box, side: Side): Point {
  if (side === 'top') return { x: box.x + box.width / 2, y: box.y }
  if (side === 'bottom') return { x: box.x + box.width / 2, y: box.y + box.height }
  if (side === 'left') return { x: box.x, y: box.y + box.height / 2 }
  return { x: box.x + box.width, y: box.y + box.height / 2 }
}

const rect = (box: Box, by = 0): Rect => ({ left: box.x - by, top: box.y - by, right: box.x + box.width + by, bottom: box.y + box.height + by })
const overlap = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/** Whether a level or upright stretch from a to b runs through the inside of r (along its edge is outside). */
export function crosses(a: Point, b: Point, r: Rect): boolean {
  if (a.y === b.y) return a.y > r.top && a.y < r.bottom && Math.max(a.x, b.x) > r.left && Math.min(a.x, b.x) < r.right
  return a.x > r.left && a.x < r.right && Math.max(a.y, b.y) > r.top && Math.min(a.y, b.y) < r.bottom
}

/** Whether a way runs through the inside of a card. */
export function runsThrough(way: Point[], box: Box): boolean {
  const r = rect(box)
  return way.some((point, index) => index > 0 && crosses(way[index - 1], point, r))
}

export type Ends = { from: Box; fromSide: Side; to: Box; toSide: Side }

/**
 * The way from one card's side to another's around `cards` (every card that might stand in the way; the two ends may
 * be among them). Points from the start to the end, each stretch level or upright; null where no way is found.
 */
export function route(ends: Ends, cards: Box[]): Point[] | null {
  const { from, to } = ends
  const others = cards.filter((card) => !same(card, from) && !same(card, to))
  // First the cards near the two ends; a card further out only once the way runs through it.
  const near = rect(
    { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.max(from.x + from.width, to.x + to.width) - Math.min(from.x, to.x), height: Math.max(from.y + from.height, to.y + to.height) - Math.min(from.y, to.y) },
    3 * GAP,
  )
  let chosen = others.filter((card) => overlap(rect(card), near))
  for (const gap of [GAP, GAP / 2, GAP / 4]) {
    for (let round = 0; round < 6; round++) {
      if (chosen.length > MANY) return null
      const way = search(ends, chosen, gap)
      if (!way) break
      const hit = others.filter((card) => !chosen.includes(card) && runsThrough(way, card))
      if (hit.length === 0) return way
      chosen = [...chosen, ...hit]
    }
  }
  return null
}

const same = (a: Box, b: Box) => a === b || (a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)

function search({ from, fromSide, to, toSide }: Ends, others: Box[], gap: number): Point[] | null {
  const start = port(from, fromSide)
  const end = port(to, toSide)
  const first = OUT[fromSide]
  const last = (OUT[toSide] + 2) % 4 // the way into a card runs against its side's outward direction
  const leave = { x: start.x + DX[first] * gap, y: start.y + DY[first] * gap }
  const arrive = { x: end.x - DX[last] * gap, y: end.y - DY[last] * gap }
  const walls = [from, to, ...others].map((box) => rect(box, gap))
  if (leave.x === arrive.x && leave.y === arrive.y) return null

  const xs = lines([leave.x, arrive.x, ...walls.flatMap((wall) => [wall.left, wall.right])])
  const ys = lines([leave.y, arrive.y, ...walls.flatMap((wall) => [wall.top, wall.bottom])])
  const nx = xs.length
  const ny = ys.length
  if (nx * ny > MANY_POINTS) return null
  const xi = new Map(xs.map((x, i) => [x, i]))
  const yi = new Map(ys.map((y, j) => [y, j]))
  const alongX = new Set(walls.flatMap((wall) => [wall.left, wall.right]))
  const alongY = new Set(walls.flatMap((wall) => [wall.top, wall.bottom]))

  // Blocked: the stretches between neighbours through a card's margin. Every edge of a margin is a grid line, so a
  // stretch between neighbours lies wholly inside a margin or wholly outside it. A point inside one is reached by no
  // stretch, nor left by one: so the search finds nothing when the short stretch out of or into a card ends in
  // another card's margin, or one card lies on the other. Turning back is never shorter, and out of a card or into
  // one its own margin forbids it.
  const level = new Uint8Array(nx * ny) // from (i, j) to (i + 1, j)
  const upright = new Uint8Array(nx * ny) // from (i, j) to (i, j + 1)
  for (const wall of walls) {
    const i0 = xi.get(wall.left)!
    const i1 = xi.get(wall.right)!
    const j0 = yi.get(wall.top)!
    const j1 = yi.get(wall.bottom)!
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * nx + i
        const inX = i > i0 && i < i1
        const inY = j > j0 && j < j1
        if (inY && i < i1) level[k] = 1
        if (inX && j < j1) upright[k] = 1
      }
    }
  }

  const goal = yi.get(arrive.y)! * nx + xi.get(arrive.x)!
  const begin = yi.get(leave.y)! * nx + xi.get(leave.x)!
  const cost = new Float64Array(nx * ny * 4).fill(Infinity)
  const back = new Int32Array(nx * ny * 4).fill(-1)
  const open = new Heap()
  const guess = (k: number) => Math.abs(xs[k % nx] - arrive.x) + Math.abs(ys[Math.floor(k / nx)] - arrive.y)
  cost[begin * 4 + first] = 0
  open.push(begin * 4 + first, guess(begin))
  while (open.size > 0) {
    const state = open.pop()
    const k = state >> 2
    const d = state & 3
    if (k === goal) return finish(state, back, xs, nx, ys, start, end)
    const i = k % nx
    const j = (k - i) / nx
    for (let turn = 0; turn < 4; turn++) {
      const ni = i + DX[turn]
      const nj = j + DY[turn]
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue
      const nk = nj * nx + ni
      if (turn === RIGHT ? level[k] : turn === LEFT ? level[nk] : turn === BOTTOM ? upright[k] : upright[nk]) continue
      const length = Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j])
      const hugging = turn === LEFT || turn === RIGHT ? alongY.has(ys[j]) : alongX.has(xs[i])
      let next = cost[state] + length * (hugging ? 1 + HUG : 1) + (turn === d ? 0 : BEND)
      if (nk === goal && turn !== last) next += BEND
      const nstate = nk * 4 + turn
      if (next < cost[nstate]) {
        cost[nstate] = next
        back[nstate] = state
        open.push(nstate, next + guess(nk))
      }
    }
  }
  return null
}

/** The grid lines along one axis: the given ones, and the middle between each two, so ways run down the middle. */
function lines(values: number[]): number[] {
  const sorted = [...new Set(values)].sort((a, b) => a - b)
  const out: number[] = []
  sorted.forEach((value, index) => {
    if (index > 0) out.push((sorted[index - 1] + value) / 2)
    out.push(value)
  })
  return out
}

function finish(state: number, back: Int32Array, xs: number[], nx: number, ys: number[], start: Point, end: Point): Point[] {
  const middle: Point[] = []
  for (let at = state; at !== -1; at = back[at]) {
    const k = at >> 2
    middle.push({ x: xs[k % nx], y: ys[Math.floor(k / nx)] })
  }
  return straighten([start, ...middle.reverse(), end])
}

/** Without points that lie on a straight stretch (a point twice lies on one, too). */
export function straighten(points: Point[]): Point[] {
  const out: Point[] = []
  for (const point of points) {
    const before = out.at(-1)
    const twice = out.at(-2)
    if (twice && before && ((twice.x === before.x && before.x === point.x) || (twice.y === before.y && before.y === point.y))) out.pop()
    out.push(point)
  }
  return out
}

/** The SVG path of a way, its corners rounded. */
export function pathOf(points: Point[], radius = RADIUS): string {
  const at = (p: Point) => `${round(p.x)} ${round(p.y)}`
  let d = `M ${at(points[0])}`
  for (let index = 1; index < points.length - 1; index++) {
    const [a, c, b] = [points[index - 1], points[index], points[index + 1]]
    const r = Math.min(radius, distance(a, c) / 2, distance(c, b) / 2)
    d += ` L ${at(toward(c, a, r))} Q ${at(c)} ${at(toward(c, b, r))}`
  }
  return d + ` L ${at(points[points.length - 1])}`
}

/** The point halfway along a way: where its label sits. */
export function middleOf(points: Point[]): Point {
  const lengths = points.slice(1).map((point, index) => distance(points[index], point))
  let left = lengths.reduce((sum, length) => sum + length, 0) / 2
  for (let index = 0; index < lengths.length; index++) {
    if (left <= lengths[index]) return toward(points[index], points[index + 1], left)
    left -= lengths[index]
  }
  return points[points.length - 1]
}

const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
const round = (value: number) => Math.round(value * 100) / 100

function toward(from: Point, to: Point, by: number): Point {
  const length = distance(from, to)
  if (length === 0) return from
  return { x: from.x + ((to.x - from.x) / length) * by, y: from.y + ((to.y - from.y) / length) * by }
}

/** A small binary heap of states by their estimate. */
class Heap {
  private states: number[] = []
  private keys: number[] = []
  get size() {
    return this.states.length
  }
  push(state: number, key: number) {
    let at = this.states.length
    this.states.push(state)
    this.keys.push(key)
    while (at > 0) {
      const parent = (at - 1) >> 1
      if (this.keys[parent] <= key) break
      this.states[at] = this.states[parent]
      this.keys[at] = this.keys[parent]
      at = parent
    }
    this.states[at] = state
    this.keys[at] = key
  }
  pop(): number {
    const top = this.states[0]
    const state = this.states.pop()!
    const key = this.keys.pop()!
    if (this.states.length > 0) {
      let at = 0
      const n = this.states.length
      for (;;) {
        let child = 2 * at + 1
        if (child >= n) break
        if (child + 1 < n && this.keys[child + 1] < this.keys[child]) child++
        if (this.keys[child] >= key) break
        this.states[at] = this.states[child]
        this.keys[at] = this.keys[child]
        at = child
      }
      this.states[at] = state
      this.keys[at] = key
    }
    return top
  }
}
