import type { GroupRow, Overview, Tiles } from '../api/client'
import { BAND_STRIDE, LINE_STRIDE, POINT_STRIDE } from './gl'
import { spaceColor } from './palette'
import { MANY_LINES, MID, Scene, openRadius, pack } from './scene'

/** A space as the server would lay it out: root 1000 wide, two folders, one of them with a subfolder. */
function overview(version = 1, links: [number, number, number][] = [[2, 3, 4]]): Overview {
  const groups: GroupRow[] = [
    [1, null, 'space', 'Work', 12, 2, 0, 0, 1000, -1, 'space', -4],
    [2, 1, 'folder', 'Plans', 5, 0, -400, 0, 300, 3, 'f:Plans', -2],
    [3, 1, 'folder', 'Daily', 2, 2, 400, 0, 200, 7, 'f:Daily', -2],
    [4, 2, 'folder', 'Old', 3, 0, -400, 100, 100, 3, 'f:Plans/Old', -1],
    [5, 1, 'bucket', 'Anchor note', 5, 0, 0, 500, 150, 1, 'space|b9', -1],
  ]
  return { status: 'ready', version, groups, links, manage: true, open_from: 80, tile: 512, working: false }
}

function tiles(): Tiles {
  return {
    tiles: [
      { level: -2, x: -2, y: -1, notes: [[10, 2, -420, 10, 6, 0, 'Plan A', 'Work/Plans/Plan A.md'], [11, 2, -380, -20, 6, 0, 'Plan B', 'Work/Plans/Plan B.md']] },
    ],
    links: [
      [10, 11],
      [10, 20],
    ],
    others: [[20, 3]],
  }
}

/** The radius a group of the scene opens by (`openRadius`: small groups open early). */
const opens = (scene: Scene, id: number) => scene.groups.get(id)!.or
/** A zoom at which every group of the scene is open, and one between two groups' opening. */
const allOpen = (scene: Scene) => (MID / Math.min(...[...scene.groups.values()].map((group) => group.or))) * 2
const between = (scene: Scene, closed: number[], open: number[]) =>
  MID / ((Math.max(...closed.map((id) => opens(scene, id))) + Math.min(...open.map((id) => opens(scene, id)))) / 2)

describe('the scene of the graph', () => {
  it('packs circles without overlap, biggest in the middle, the same every time', () => {
    const radii = [100, 300, 50, 200]
    const placed = pack(radii, 10)
    expect(placed).toEqual(pack(radii, 10))
    expect(placed[1]).toEqual({ x: 0, y: 0 })
    for (let i = 0; i < radii.length; i++)
      for (let j = i + 1; j < radii.length; j++)
        expect(Math.hypot(placed[i].x - placed[j].x, placed[i].y - placed[j].y)).toBeGreaterThanOrEqual(radii[i] + radii[j] + 10 - 1e-6)
  })

  it('reads the overview: nesting, own notes, colours, parent radius', () => {
    const scene = new Scene()
    scene.setOverviews([{ name: 'Work', overview: overview() }])
    const plans = scene.groups.get(2)!
    expect(plans.own).toBe(2) // 5 below, 3 of them in Old
    expect(scene.groups.get(1)!.own).toBe(12 - 5 - 2 - 5)
    expect(plans.parentR).toBe(1000)
    expect(plans.depth).toBe(2)
    expect(scene.groups.get(4)!.depth).toBe(3)
    expect(scene.groups.get(1)!.children).toEqual([2, 3, 5])
  })

  it('colours a space by its place in the whole list, also when the spaces before it are left out', () => {
    const alone = new Scene()
    alone.setOverviews([{ name: 'Work', overview: overview(), index: 1 }])
    expect(alone.spaceColours()).toEqual([spaceColor(1)])
    expect(spaceColor(1)).not.toBe(spaceColor(0))
    const first = new Scene()
    first.setOverviews([{ name: 'Work', overview: overview() }])
    expect(first.spaceColours()).toEqual([spaceColor(0)])
  })

  it('knows which groups are closed at a zoom, and the outermost closed one around a group', () => {
    const scene = new Scene()
    scene.setOverviews([{ name: 'Work', overview: overview() }])
    // Everything closed: the space itself.
    expect(scene.representative(4, MID / opens(scene, 1) / 2)).toBe(1)
    // The space open, Plans and Daily still closed.
    const k = between(scene, [2, 3], [1])
    expect(scene.representative(4, k)).toBe(2)
    expect(scene.representative(3, k)).toBe(3)
    // All open.
    expect(scene.representative(4, allOpen(scene))).toBe(-1)
    // The count of closed groups changes exactly when one crosses the middle.
    const least = Math.min(...[...scene.groups.values()].map((group) => group.or))
    expect(scene.band(MID / (least * 0.99))).toBe(0)
    expect(scene.band(MID / (least * 1.01))).toBe(1)
    expect(scene.band(MID / opens(scene, 1) / 2)).toBe(5)
  })

  it('bundles links between groups of two spaces from the counts across them', () => {
    const other: Overview = {
      ...overview(1, []),
      groups: [
        [101, null, 'space', 'Homelab', 3, 0, 0, 0, 400, -1, 'space', -3],
        [102, 101, 'folder', 'Storage', 3, 0, 0, 0, 200, 2, 'f:Storage', -2],
      ],
    }
    const scene = new Scene()
    scene.setOverviews([
      { name: 'Work', overview: overview(1, []) },
      { name: 'Homelab', overview: other },
    ])
    const k = between(scene, [2, 102], [1, 101]) // Plans and Storage closed, the spaces open
    expect(scene.lineBuffers(k, null).bandCount).toBe(0)
    scene.across = [[2, 102, 3]]
    const drawn = scene.lineBuffers(k, null)
    expect(drawn.bandCount).toBe(6)
    const band = new Float32Array(drawn.bands)
    // From Plans to Storage, in the places the packing gave each space.
    const plans = scene.groups.get(2)!
    const storage = scene.groups.get(102)!
    expect([band[2], band[3], band[4], band[5]]).toEqual([plans.x, plans.y, storage.x, storage.y])
    expect(band[12]).toBeCloseTo(1 + Math.log2(3) * 1.3)
    // A pair with a group the scene does not know (a space not shown) draws nothing.
    scene.across = [[2, 999, 5]]
    expect(scene.lineBuffers(k, null).bandCount).toBe(0)
  })

  it('bundles links between closed groups and draws the rest from the notes', () => {
    const scene = new Scene()
    scene.setOverviews([{ name: 'Work', overview: overview() }])
    scene.addTiles('Work', 1, [scene.tileKey('Work', -2, -2, -1)], tiles())
    // Plans and Daily closed: one bundle from the overview's count, nothing thin.
    const closed = scene.lineBuffers(between(scene, [2, 3], [1]), null)
    expect(closed.lineCount).toBe(0)
    expect(closed.bandCount).toBe(6)
    const band = new Float32Array(closed.bands)
    // Width of the band: the 13th number of a vertex (after corner, ends and both circles).
    expect(band[12]).toBeCloseTo(1 + Math.log2(4) * 1.3)
    expect(band.length).toBe((6 * BAND_STRIDE) / 4)
    // All open: a thin line between the two plans; the link to Daily ends at a note that is not loaded.
    const open = scene.lineBuffers(allOpen(scene), null)
    expect(open.lineCount).toBe(2)
    expect(new Float32Array(open.lines).length).toBe((2 * LINE_STRIDE) / 4)
    // The note outside the tiles is not drawn as a dot; its end is known, but there is no note to end at.
    expect(open.bandCount).toBe(0)
    // Hot: the focus's links become bands.
    const hot = scene.lineBuffers(allOpen(scene), 10)
    expect(hot.lineCount).toBe(0)
    expect(hot.bandCount).toBe(6)
  })

  it('draws only the lines of the focus from notes when there are very many', () => {
    const scene = new Scene()
    scene.setOverviews([{ name: 'Work', overview: overview() }])
    const notes: [number, number, number, number, number, number, string, string][] = []
    const links: [number, number][] = []
    for (let n = 0; n <= MANY_LINES + 1; n++) {
      notes.push([100 + n, 2, -400 + (n % 20), (n / 20) | 0, 6, 0, 'N' + n, 'Work/Plans/N' + n + '.md'])
      if (n) links.push([100, 100 + n])
    }
    scene.addTiles('Work', 1, [], { tiles: [{ level: -2, x: 0, y: 0, notes }], links, others: [] })
    // All open: more than the limit, so nothing thin; the focus keeps its lines as hot bands.
    expect(scene.lineBuffers(allOpen(scene), null).lineCount).toBe(0)
    expect(scene.lineBuffers(allOpen(scene), 100).bandCount).toBe((MANY_LINES + 1) * 6)
    expect(scene.lineBuffers(allOpen(scene), 101).bandCount).toBe(6)
    // The bundles between closed groups do not count and stay.
    expect(scene.lineBuffers(between(scene, [2, 3], [1]), null).bandCount).toBe(6)
    // Zoomed in on a few of them: only the lines that reach into the view count, and those are drawn.
    const all = scene.lineBuffers(allOpen(scene), null, { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 })
    expect(all.lineCount).toBe(0)
    const ends = [...scene.notes.values()].filter((note) => note.id >= 100)
    const far = ends.reduce((best, note) => (note.y > best.y ? note : best), ends[0])
    const near = scene.lineBuffers(allOpen(scene), null, { x0: far.x - 0.5, y0: far.y - 0.5, x1: far.x + 0.5, y1: far.y + 0.5 })
    expect(near.lineCount).toBeGreaterThan(0)
    expect(near.lineCount).toBeLessThanOrEqual(MANY_LINES)
  })

  it('puts notes where their space is and hides daily notes on request', () => {
    const scene = new Scene()
    scene.setOverviews([{ name: 'Work', overview: overview() }])
    scene.addTiles('Work', 1, [], tiles())
    const points = scene.pointBuffer()
    expect(points.ids).toEqual([10, 11])
    expect(new Float32Array(points.data).length).toBe((2 * POINT_STRIDE) / 4)
    // The radius the note's group opens by (larger than its 300: it holds few items).
    expect(new Float32Array(points.data)[3]).toBeCloseTo(opens(scene, 2), 2)
    expect(opens(scene, 2)).toBeGreaterThan(300)
    scene.hideDaily = true
    expect(scene.hidden(scene.groups.get(3)!)).toBe(true)
    expect(scene.hidden(scene.groups.get(1)!)).toBe(false)
    const flags = scene.pointFlags(points.ids, 10, null, new Set([11]))
    expect([...flags]).toEqual([0, 255, 0, 0, 0, 0, 0, 255])
    // A daily note among other notes: its group stays, the note itself is hidden.
    scene.addTiles('Work', 1, [], { tiles: [{ level: -2, x: 0, y: 0, notes: [[12, 2, -400, 40, 6, 1, '2026-09-27', 'Work/Plans/2026-09-27.md']] }], links: [], others: [] })
    const more = scene.pointBuffer()
    const daily = scene.pointFlags(more.ids, null, null, new Set())
    expect(daily[more.ids.indexOf(12) * 4 + 2]).toBe(255)
    expect(daily[more.ids.indexOf(10) * 4 + 2]).toBe(0)
    scene.hideDaily = false
    expect(scene.pointFlags(more.ids, null, null, new Set())[more.ids.indexOf(12) * 4 + 2]).toBe(0)
  })

  it('asks only for the tiles of open groups in view, at their level', () => {
    const scene = new Scene()
    scene.setOverviews([{ name: 'Work', overview: overview() }])
    // Zoom where Plans starts to open, looking at its middle.
    const k = 80 / opens(scene, 2)
    const wanted = scene.wanted({ x: -400, y: 0, k }, 400, 300, 512)
    const keys = (wanted.get('Work') ?? []).map((item) => item.tile)
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.every((key) => key.startsWith('-2:'))).toBe(true)
    // Far out, nothing is open enough.
    expect(scene.wanted({ x: 0, y: 0, k: 0.01 }, 400, 300, 512).size).toBe(0)
    // A version change drops what was loaded for the space.
    scene.addTiles('Work', 1, [scene.tileKey('Work', -2, -2, -1)], tiles())
    expect(scene.notes.size).toBe(2)
    scene.setOverviews([{ name: 'Work', overview: overview(2) }])
    expect(scene.notes.size).toBe(0)
    expect(scene.tiles.size).toBe(0)
    // An answer that was asked for the old version arrives late: dropped, not stored under the new one.
    scene.addTiles('Work', 1, [scene.tileKey('Work', -2, -2, -1)], tiles())
    expect(scene.notes.size).toBe(0)
    expect(scene.tiles.size).toBe(0)
    scene.addTiles('Work', 2, [scene.tileKey('Work', -2, -2, -1)], tiles())
    expect(scene.notes.size).toBe(2)
  })

  it('hits the note under the pointer, else the deepest closed group', () => {
    const scene = new Scene()
    scene.setOverviews([{ name: 'Work', overview: overview() }])
    scene.addTiles('Work', 1, [], tiles())
    const space = scene.space('Work')!
    const camera = { x: space.ox - 400, y: space.oy, k: 1 }
    // Plans open at zoom 1: the note at -420/10 is hit.
    expect(scene.hit(200 - 20, 150 + 10, camera, 400, 300)).toEqual({ kind: 'note', id: 10 })
    // Far out: the space bubble.
    expect(scene.hit(200, 150, { x: space.ox, y: space.oy, k: 0.05 }, 400, 300)).toEqual({ kind: 'group', id: 1 })
    expect(scene.centre({ x: space.ox - 400, y: space.oy, k: 1 })?.id).toBe(2)
  })
})

describe('symbols and colours chosen by hand', () => {
  it('colour a folder and the folders in it, mark it with its symbol, and go back to nexlore’s own when taken away', () => {
    const scene = new Scene()
    scene.setOverviews([{ name: 'Work', overview: overview() }])
    const byKey = (key: string) => [...scene.groups.values()].find((group) => group.key === key)!
    const own = { plans: byKey('f:Plans').color, old: byKey('f:Plans/Old').color, daily: byKey('f:Daily').color, space: byKey('space').color }
    // A colour none of them has of its own: otherwise a look that is ignored looks the same as one that holds.
    const chosen = ['#fb7185', '#38bdf8', '#a3e635', '#9a9aa8'].find((colour) => !Object.values(own).includes(colour))!
    scene.applyLooks({ Work: { '': { icon: 'home', color: null }, Plans: { icon: 'star', color: chosen } } })
    expect(byKey('f:Plans')).toMatchObject({ color: chosen, icon: 'star' })
    // The folder in it takes the colour, not the symbol; a folder beside it keeps its own; the space its colour.
    expect(byKey('f:Plans/Old')).toMatchObject({ color: chosen, icon: null })
    expect(byKey('f:Daily').color).toBe(own.daily)
    expect(byKey('space')).toMatchObject({ color: own.space, icon: 'home' })
    // A group that is not a folder (a bucket of the split) knows no looks.
    expect(byKey('space|b9').icon).toBeNull()
    // New overviews keep them; taking them away brings nexlore's colours back.
    scene.setOverviews([{ name: 'Work', overview: overview(2) }])
    expect(byKey('f:Plans').color).toBe(chosen)
    scene.applyLooks({})
    expect(byKey('f:Plans')).toMatchObject({ color: own.plans, icon: null })
    expect(byKey('f:Plans/Old').color).toBe(own.old)
    // The colour of a space is its own: its folders keep theirs.
    scene.applyLooks({ Work: { '': { icon: null, color: chosen } } })
    expect(byKey('space').color).toBe(chosen)
    expect(byKey('f:Daily').color).toBe(own.daily)
  })

  it('opens a group early when its items have room on screen, a large one only closer', () => {
    // As the folder of the attrappe: a few notes are seen from afar, a group of hundreds keeps its bubble longer.
    expect(openRadius(100, 3)).toBeCloseTo((100 * 80) / 36)
    expect(openRadius(100, 26)).toBeCloseTo((100 * 80) / (9 * Math.sqrt(27)))
    expect(openRadius(100, 500)).toBe(100)
    const scene = new Scene()
    scene.setOverviews([{ name: 'Work', overview: overview() }])
    // Its children open by their own size and items; the parent's opening travels along.
    expect(scene.groups.get(4)!.opr).toBe(opens(scene, 2))
  })
})
