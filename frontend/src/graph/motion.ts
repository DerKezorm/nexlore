/**
 * The map moves (design answer 05.10.2026, after the attrappe `tools/graph-attrappe/`): notes in sight swing into
 * place when their group opens, and a note dragged pulls its neighbours along; everything stays in its own circle.
 *
 * Only the notes on screen take part (at most `MAX_MOVING`), so a vault of 100,000 notes costs what a screen holds.
 * As in the attrappe, links pull their notes together into bunches and all notes keep each other at a distance; the
 * place the server gave a note pulls only lightly, so the map stays recognisable (05.10.2026, compared with the
 * attrappe: the layout of the server alone spread linked notes evenly over their circle). Links into other
 * groups do not pull: a note would only hang at the edge of its circle. A dropped note holds its place more firmly.
 * Nothing is saved: a reload brings the server's layout back and lets it settle again.
 */
import type { Scene, SceneNote } from './scene'

/** More notes than this in sight and only the dragged one and its neighbours move. */
export const MAX_MOVING = 1500
const MAX_PARKED = 20000
/** Below this the map counts as still and is no longer worked on. */
export const AT_REST = 0.002
/** The forces cool down step by step, as in d3: whatever pushes against what, the map comes to rest. Measured in
 * the preview on 05.10.2026: without it, notes the push held against the edge of their circle never stopped. */
const COOLING = 0.98
const COLD = 0.02
/** How hard the server's place pulls; a dropped note's own place pulls harder. */
const HOME = 0.004
const DROPPED = 0.12
const ALONG = 0.045
/** Linked notes rest at this many times their radii apart. */
const REST = 3.4
/** Every note pushes the others away within `REACH` (world units), more the closer they are. */
const PUSH = 900
const REACH = 110
const FRICTION = 0.74
/** How far toward the middle of its group a note starts when it swings in. */
const SWING = 0.55

/**
 * `wx`, `wy`: where this module last put the note. `ox`, `oy`: where the server had it. A tile loaded again brings
 * the server's place back (often as a new object): the note keeps its own then; another place is a new layout.
 */
type Body = { note: SceneNote; hx: number; hy: number; vx: number; vy: number; wx: number; wy: number; ox: number; oy: number; dropped: boolean }

export class Motion {
  private bodies = new Map<number, Body>()
  /** Notes that left the screen: they keep their place and come back without waking anything (measured 05.10.2026:
   * notes at the edge of the screen went out and in again every second, and each time woke the map). */
  private parked = new Map<number, Body>()
  /** The links between moving notes of one group, looked up once whenever who moves changes (going through all
   * links in every step took most of a frame with 50,000 notes, 05.10.2026). */
  private pairs: [Body, Body][] | null = null
  /** The links of each note, from the scene's links: kept until those change. */
  private links: Map<number, number[]> | null = null
  private linksSeen: Map<string, [number, number]> | null = null
  private linkCount = -1
  private energy = 0
  /** How strong the forces are now, from 1 (just woken) down to `COLD` (still). */
  private heat = 0
  /** The note under the pointer while it is dragged. */
  private held: Body | null = null
  /** A note was put somewhere since the view last asked (`changed`): its dot must be drawn again. */
  private dirty = false
  /** Without motion (the system asks for less): notes follow the pointer, nothing else moves. */
  calm = false

  /** Whether a note was put somewhere since the last call; the view draws the dots again then (seen 05.10.2026: with
   * less motion asked for no step ran, and a dragged dot stayed behind its name and lines). */
  changed(): boolean {
    const was = this.dirty
    this.dirty = false
    return was
  }

  /** Whether anything still moves: the view draws another frame while it does. */
  get moving(): boolean {
    return (this.energy > AT_REST && this.heat > COLD) || this.held !== null
  }

  /** Forget everything (the layout came new from the server). */
  reset(): void {
    for (const body of [...this.bodies.values(), ...this.parked.values()]) {
      body.note.x = body.ox
      body.note.y = body.oy
    }
    this.bodies.clear()
    this.pairs = null
    this.parked.clear()
    this.held = null
    this.energy = 0
    this.heat = 0
  }

  /**
   * The notes in sight as they come: one seen for the first time starts toward the middle of its group and swings
   * home when `swing` says so (its group has just opened), one known keeps where it is. Notes no longer in sight are
   * parked where they are and come back as they were. A note the server put somewhere else takes that as its home.
   */
  take(scene: Scene, inSight: SceneNote[], swing: (note: SceneNote) => boolean): void {
    const wanted = new Set<number>()
    for (const note of inSight.slice(0, MAX_MOVING)) {
      wanted.add(note.id)
      const back = this.parked.get(note.id)
      if (back) {
        this.parked.delete(note.id)
        this.bodies.set(note.id, back)
        this.pairs = null
      }
      const known = this.bodies.get(note.id)
      if (known) {
        if (note.x !== known.wx || note.y !== known.wy) {
          if (note.x === known.ox && note.y === known.oy) {
            // The same place from the server again: the note stays where it moved to.
            note.x = known.wx
            note.y = known.wy
            this.dirty = true
          } else {
            // Laid out anew: that place is its home now.
            known.hx = known.wx = known.ox = note.x
            known.hy = known.wy = known.oy = note.y
            known.vx = known.vy = 0
          }
        }
        known.note = note
        continue
      }
      const body: Body = { note, hx: note.x, hy: note.y, vx: 0, vy: 0, wx: note.x, wy: note.y, ox: note.x, oy: note.y, dropped: false }
      // New in sight: it settles into its bunch.
      if (!this.calm) this.wake(0.6)
      const group = scene.groups.get(note.group)
      if (group && !this.calm && swing(note)) {
        note.x = body.wx = group.x + (note.x - group.x) * (1 - SWING)
        note.y = body.wy = group.y + (note.y - group.y) * (1 - SWING)
        this.dirty = true
        this.wake(1)
      }
      this.bodies.set(note.id, body)
      this.pairs = null
    }
    for (const [id, body] of this.bodies) {
      if (wanted.has(id) || body === this.held) continue
      this.bodies.delete(id)
      this.pairs = null
      this.parked.set(id, body)
    }
    // A vault walked through far: the notes parked longest go (they are where the server had them on the next look).
    for (const id of this.parked.keys()) {
      if (this.parked.size <= MAX_PARKED) break
      this.parked.delete(id)
    }
  }

  /** The notes taking part now: the view writes their places into its buffers when `changed` says so. */
  notes(): SceneNote[] {
    return [...this.bodies.values()].map((body) => body.note)
  }

  /** A note taken by the pointer; false when it is not among the moving ones. */
  grab(id: number): boolean {
    const body = this.bodies.get(id)
    if (!body) return false
    this.held = body
    return true
  }

  /** The held note follows the pointer (world coordinates), inside its group. */
  drag(scene: Scene, x: number, y: number): void {
    if (!this.held) return
    const inside = this.inside(scene, this.held.note, x, y)
    this.held.note.x = this.held.wx = inside.x
    this.held.note.y = this.held.wy = inside.y
    this.dirty = true
    this.held.vx = this.held.vy = 0
    this.wake(0.4)
  }

  /** Let go: the note stays where it was dropped (its new home), the others settle around it. */
  drop(): void {
    if (!this.held) return
    this.held.hx = this.held.note.x
    this.held.hy = this.held.note.y
    this.held.dropped = true
    this.held = null
  }

  private wake(heat: number): void {
    this.heat = Math.max(this.heat, heat)
    this.energy = Math.max(this.energy, 1)
  }

  /** One step of the springs; true when a note moved. */
  step(scene: Scene): boolean {
    if (this.calm || !this.moving || !this.bodies.size) return false
    const bodies = [...this.bodies.values()]
    // Apart: only notes close to each other, found through a grid of cells as wide as the reach.
    const reach = REACH
    const cells = new Map<string, Body[]>()
    for (const body of bodies) {
      const key = Math.floor(body.note.x / reach) + ':' + Math.floor(body.note.y / reach)
      const cell = cells.get(key)
      if (cell) cell.push(body)
      else cells.set(key, [body])
    }
    for (const body of bodies) {
      const cx = Math.floor(body.note.x / reach)
      const cy = Math.floor(body.note.y / reach)
      for (let i = -1; i <= 1; i++)
        for (let j = -1; j <= 1; j++)
          for (const other of cells.get(cx + i + ':' + (cy + j)) ?? []) {
            if (other === body) continue
            if (other.note.group !== body.note.group) continue
            const dx = body.note.x - other.note.x
            const dy = body.note.y - other.note.y
            const d = Math.max(Math.hypot(dx, dy), 1)
            if (d >= reach) continue
            const push = (PUSH * this.heat) / (d * d * d)
            body.vx += dx * push
            body.vy += dy * push
          }
    }
    // Along the links between moving notes of one group: they come together, at a few radii apart.
    if (!this.links || this.linksSeen !== scene.links || this.linkCount !== scene.links.size) {
      this.links = new Map()
      for (const [a, b] of scene.links.values()) {
        const la = this.links.get(a)
        if (la) la.push(b)
        else this.links.set(a, [b])
        const lb = this.links.get(b)
        if (lb) lb.push(a)
        else this.links.set(b, [a])
      }
      this.linksSeen = scene.links
      this.linkCount = scene.links.size
      this.pairs = null
    }
    if (!this.pairs) {
      // From each moving note to its moving neighbours, each pair once: as many steps as moving notes and links.
      this.pairs = []
      for (const p of this.bodies.values()) {
        for (const other of this.links.get(p.note.id) ?? []) {
          if (other <= p.note.id) continue
          const q = this.bodies.get(other)
          if (q && q.note.group === p.note.group) this.pairs.push([p, q])
        }
      }
    }
    for (const [p, q] of this.pairs) {
      const dx = q.note.x - p.note.x
      const dy = q.note.y - p.note.y
      const d = Math.hypot(dx, dy) || 0.01
      const rest = (p.note.r + q.note.r) * REST
      const pull = ((d - rest) / d) * ALONG * this.heat
      p.vx += dx * pull
      p.vy += dy * pull
      q.vx -= dx * pull
      q.vy -= dy * pull
    }
    let energy = 0
    for (const body of bodies) {
      if (body === this.held) continue
      const home = (body.dropped ? DROPPED : HOME) * this.heat
      body.vx = (body.vx + (body.hx - body.note.x) * home) * FRICTION
      body.vy = (body.vy + (body.hy - body.note.y) * home) * FRICTION
      const next = this.inside(scene, body.note, body.note.x + body.vx, body.note.y + body.vy)
      // What it really moved: held at the edge of its circle, a note stands still whatever its speed was.
      body.vx = next.x - body.note.x
      body.vy = next.y - body.note.y
      body.note.x = body.wx = next.x
      body.note.y = body.wy = next.y
      energy = Math.max(energy, Math.hypot(body.vx, body.vy) / Math.max(body.note.r, 1))
    }
    this.energy = energy
    if (!this.held) this.heat *= COOLING
    this.dirty = true
    return true
  }

  /** A place for a note inside its own circle. */
  private inside(scene: Scene, note: SceneNote, x: number, y: number): { x: number; y: number } {
    const group = scene.groups.get(note.group)
    if (!group) return { x, y }
    const dx = x - group.x
    const dy = y - group.y
    const d = Math.hypot(dx, dy)
    const room = Math.max(0, group.r - note.r - 2)
    return d <= room ? { x, y } : { x: group.x + (dx / d) * room, y: group.y + (dy / d) * room }
  }
}
