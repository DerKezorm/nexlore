import { describe, expect, it } from 'vitest'

import type { GroupRow, Overview } from '../api/client'
import { Motion } from './motion'
import { Scene } from './scene'

/** One group of radius 200; A–B and B–C linked, D alone. */
function scene(): Scene {
  const groups: GroupRow[] = [
    [1, null, 'space', 'Work', 4, 0, 0, 0, 1000, -1, 'space', -4],
    [2, 1, 'folder', 'Plans', 4, 0, 0, 0, 200, 3, 'f:Plans', -2],
  ]
  const overview: Overview = { status: 'ready', version: 1, groups, links: [], manage: true, open_from: 80, tile: 512, working: false }
  const made = new Scene()
  made.setOverviews([{ name: 'Work', overview }])
  made.addTiles('Work', 1, [], {
    tiles: [
      {
        level: -2, x: 0, y: 0,
        notes: [
          [10, 2, -120, 0, 6, 0, 'A', 'Work/Plans/A.md'],
          [11, 2, 120, 0, 6, 0, 'B', 'Work/Plans/B.md'],
          [12, 2, 0, 140, 6, 0, 'C', 'Work/Plans/C.md'],
          [13, 2, 0, -160, 6, 0, 'D', 'Work/Plans/D.md'],
        ],
      },
    ],
    links: [[10, 11], [11, 12]],
    others: [],
  })
  return made
}

const at = (made: Scene, id: number) => {
  const note = made.notes.get(id)!
  return [Math.round(note.x) + 0, Math.round(note.y) + 0]
}
const apart = (made: Scene, a: number, b: number) => {
  const p = made.notes.get(a)!
  const q = made.notes.get(b)!
  return Math.hypot(p.x - q.x, p.y - q.y)
}

function settle(motion: Motion, made: Scene, steps = 1500) {
  for (let i = 0; i < steps && motion.moving; i++) motion.step(made)
}

describe('the map in motion', () => {
  it('draws linked notes together into a bunch and comes to rest; a note without links stays near its place', () => {
    const made = scene()
    const motion = new Motion()
    motion.take(made, [...made.notes.values()], () => false)
    expect(motion.moving).toBe(true)
    settle(motion, made)
    expect(motion.moving).toBe(false)
    expect(apart(made, 10, 11)).toBeLessThan(120)
    expect(apart(made, 11, 12)).toBeLessThan(120)
    // Apart all the same: never on top of each other.
    expect(apart(made, 10, 11)).toBeGreaterThan(20)
    const [dx, dy] = at(made, 13)
    expect(Math.hypot(dx, dy + 160)).toBeLessThan(40)
  })

  it('swings the notes in from the middle of their group when it has just opened', () => {
    const made = scene()
    const motion = new Motion()
    motion.take(made, [...made.notes.values()], () => true)
    expect(at(made, 10)[0]).toBeGreaterThan(-120 * 0.5)
    settle(motion, made)
    expect(motion.moving).toBe(false)
  })

  it('pulls the neighbours of a dragged note along, and the note stays where it is dropped', () => {
    const made = scene()
    const motion = new Motion()
    motion.take(made, [...made.notes.values()], () => false)
    settle(motion, made)
    const before = at(made, 11)
    const lonely = at(made, 13)
    expect(motion.grab(10)).toBe(true)
    for (let i = 0; i <= 40; i++) {
      motion.drag(made, -100 + i * 2, 100 + i * 2)
      motion.step(made)
    }
    // Its neighbour came along toward it, the note without links hardly moved.
    expect(at(made, 11)[1]).toBeGreaterThan(before[1] + 5)
    expect(Math.hypot(at(made, 13)[0] - lonely[0], at(made, 13)[1] - lonely[1])).toBeLessThan(15)
    motion.drop()
    settle(motion, made)
    const [x, y] = at(made, 10)
    // Within a few units: its links still pull a little.
    expect(Math.hypot(x + 20, y - 180)).toBeLessThan(8)
  })

  it('keeps every note inside its own circle', () => {
    const made = scene()
    const motion = new Motion()
    motion.take(made, [...made.notes.values()], () => false)
    motion.grab(12)
    for (let i = 0; i < 30; i++) {
      motion.drag(made, 0, 900)
      motion.step(made)
    }
    settle(motion, made)
    for (const note of made.notes.values()) expect(Math.hypot(note.x, note.y)).toBeLessThanOrEqual(200 - note.r)
  })

  it('parks a note that leaves the screen and takes it back as it was, without waking the map', () => {
    const made = scene()
    const motion = new Motion()
    motion.take(made, [...made.notes.values()], () => false)
    settle(motion, made)
    const kept = at(made, 11)
    motion.take(made, [made.notes.get(10)!], () => false)
    expect(at(made, 11)).toEqual(kept)
    // Back in sight, as a new object of a tile loaded again: the same place, nothing moves.
    made.notes.set(11, { ...made.notes.get(11)!, x: 120, y: 0 })
    motion.take(made, [...made.notes.values()], () => true)
    expect(at(made, 11)).toEqual(kept)
    expect(motion.moving).toBe(false)
    // The map going: every note back where the server had it.
    motion.reset()
    expect(at(made, 10)).toEqual([-120, 0])
    expect(at(made, 11)).toEqual([120, 0])
    expect(motion.moving).toBe(false)
  })

  it('takes a place the server gave a note in between as its new home', () => {
    const made = scene()
    const motion = new Motion()
    motion.take(made, [...made.notes.values()], () => false)
    settle(motion, made)
    const note = made.notes.get(13)!
    note.x = 90
    note.y = -110
    motion.take(made, [...made.notes.values()], () => false)
    motion.grab(10)
    motion.drag(made, -70, 0)
    settle(motion, made, 50)
    motion.drop()
    settle(motion, made)
    const [x, y] = at(made, 13)
    expect(Math.hypot(x - 90, y + 110)).toBeLessThan(40)
  })

  it('keeps a dropped note where it is when its tile comes again with the same place', () => {
    const made = scene()
    const motion = new Motion()
    motion.take(made, [...made.notes.values()], () => false)
    motion.grab(13)
    motion.drag(made, 30, -120)
    motion.drop()
    settle(motion, made)
    const kept = at(made, 13)
    // The tile again, as from the server: new objects, the old places.
    made.notes.set(13, { ...made.notes.get(13)!, x: 0, y: -160 })
    motion.take(made, [...made.notes.values()], () => false)
    expect(at(made, 13)).toEqual(kept)
  })

  it('comes to rest in a crowded circle too, where the push holds notes against its edge', () => {
    const groups: GroupRow[] = [
      [1, null, 'space', 'Work', 60, 0, 0, 0, 1000, -1, 'space', -4],
      [2, 1, 'folder', 'Full', 60, 0, 0, 0, 90, 3, 'f:Full', -2],
    ]
    const overview: Overview = { status: 'ready', version: 1, groups, links: [], manage: true, open_from: 80, tile: 512, working: false }
    const made = new Scene()
    made.setOverviews([{ name: 'Work', overview }])
    const notes = Array.from({ length: 60 }, (_, i) => [100 + i, 2, Math.cos(i) * 60, Math.sin(i) * 60, 8, 0, 'N' + i, `Work/Full/N${i}.md`] as [number, number, number, number, number, number, string, string])
    const links = Array.from({ length: 59 }, (_, i) => [100 + i, 101 + i] as [number, number])
    made.addTiles('Work', 1, [], { tiles: [{ level: -2, x: 0, y: 0, notes }], links, others: [] })
    const motion = new Motion()
    motion.take(made, [...made.notes.values()], () => true)
    let steps = 0
    while (motion.moving && steps < 2000) {
      motion.step(made)
      steps++
    }
    expect(motion.moving).toBe(false)
    expect(steps).toBeLessThan(400)
  })

  it('says when a note was put somewhere, also a dragged one while nothing else may move', () => {
    const made = scene()
    const motion = new Motion()
    motion.calm = true
    motion.take(made, [...made.notes.values()], () => true)
    // Calm: nothing swings in, nothing settles.
    expect(motion.changed()).toBe(false)
    expect(motion.step(made)).toBe(false)
    expect(at(made, 10)).toEqual([-120, 0])
    motion.grab(10)
    motion.drag(made, -60, 30)
    expect(motion.changed()).toBe(true)
    expect(motion.changed()).toBe(false)
    motion.step(made)
    // Its neighbour stays: no swimming when less motion is asked for.
    expect(at(made, 11)).toEqual([120, 0])
    motion.drop()
    expect(at(made, 10)).toEqual([-60, 30])
  })
})
