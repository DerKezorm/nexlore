/**
 * What the graph shows, in the browser: the circles of every space (from the overview) and the notes of the tiles
 * loaded so far, with the links between them. Plain data and arithmetic, no drawing: `GraphView` hands the buffers
 * built here to `gl.ts` and the label candidates to `labels.ts`.
 *
 * Each space was laid out by the server around its own middle; here the spaces are put side by side (`pack`), so a
 * point on the map is the server's position plus the offset of its space.
 *
 * Semantic zoom: a group is closed while its radius on screen is below `MID` (half open). A line then ends at the
 * outermost closed group around its note (`representative`), and all lines between the same two closed groups become
 * one bundle, thicker the more links it carries. Which groups are closed depends only on the zoom, and it changes in
 * steps: groups sorted by radius, the count of closed ones says everything (`band`).
 */
import type { GroupKind, GroupRow, Overview, TileNote, Tiles } from '../api/client'
import { BAND_STRIDE, BUBBLE_STRIDE, LINE_STRIDE, MAX_DOT, MIN_DOT, OPEN_FROM, OPEN_TO, POINT_STRIDE, type Camera } from './gl'
import { slotColor, spaceColor } from './palette'

/** Half open: from here on a group counts as open, its notes are drawn and lines end at them. */
export const MID = (OPEN_FROM + OPEN_TO) / 2
/** Tiles loaded at most; the ones out of sight longest go first. */
const MAX_TILES = 1500
const SPACE_GAP = 80
/** More lines from notes than this, and only the focus keeps its own: the map stays readable. */
export const MANY_LINES = 300

export type SceneGroup = {
  id: number
  space: string
  parent: number | null
  kind: GroupKind
  name: string
  key: string
  total: number
  daily: number
  /** Notes directly in the group (not in subgroups). */
  own: number
  x: number
  y: number
  r: number
  level: number
  color: string
  depth: number
  children: number[]
  parentR: number
}

export type SceneNote = {
  id: number
  space: string
  group: number
  lx: number
  ly: number
  x: number
  y: number
  r: number
  daily: boolean
  title: string
  path: string
}

type Other = { id: number; space: string; group: number }
type Tile = { key: string; space: string; ids: number[]; used: number }
type SpaceState = { name: string; index: number; root: number; ox: number; oy: number; r: number; version: number; pairs: [number, number, number][] }

function ease(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
export const openness = (r: number, k: number) => (r <= 0 ? 1 : ease(OPEN_FROM, OPEN_TO, r * k))
export const shell = (o: number) => 1 - ease(0.15, 0.75, o)
export const ring = (o: number) => ease(0.1, 0.5, o)
export const inner = (o: number) => ease(0.1, 0.6, o)

function rgba(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

/**
 * Circles side by side, the biggest first, each next one where it touches one already placed and lies nearest the
 * middle. Deterministic: the same spaces give the same map.
 */
export function pack(radii: number[], gap = SPACE_GAP): { x: number; y: number }[] {
  const order = radii.map((r, i) => [r, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1])
  const placed: { x: number; y: number; r: number }[] = []
  const out: { x: number; y: number }[] = new Array(radii.length)
  for (const [r, index] of order) {
    let best: { x: number; y: number } | null = null
    if (placed.length === 0) best = { x: 0, y: 0 }
    else {
      let bestDistance = Infinity
      for (const other of placed) {
        for (let step = 0; step < 72; step++) {
          const angle = (step / 72) * Math.PI * 2
          const d = other.r + r + gap
          const x = other.x + Math.cos(angle) * d
          const y = other.y + Math.sin(angle) * d
          if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < p.r + r + gap - 1e-6)) continue
          const distance = Math.hypot(x, y)
          if (distance < bestDistance - 1e-9) {
            bestDistance = distance
            best = { x, y }
          }
        }
      }
    }
    placed.push({ ...best!, r })
    out[index] = best!
  }
  return out
}

export class Scene {
  spaces: SpaceState[] = []
  groups = new Map<number, SceneGroup>()
  notes = new Map<number, SceneNote>()
  others = new Map<number, Other>()
  /** Links between loaded notes (or a loaded note and one outside): `min|max` of the ids. */
  links = new Map<string, [number, number]>()
  tiles = new Map<string, Tile>()
  hideDaily = false
  /** Groups sorted by radius, for working out which are closed at a zoom. */
  private byRadius: SceneGroup[] = []
  private clock = 0
  /** Tiles touched at or after this tick are in view now and are never pushed out. */
  private inView = 0

  // --- Loading ------------------------------------------------------------------------------------------------------

  /** The overviews of every space shown, in the order of the space list. */
  setOverviews(list: { name: string; overview: Overview }[]) {
    const previous = new Map(this.spaces.map((s) => [s.name, s]))
    this.groups.clear()
    this.spaces = []
    for (const [index, { name, overview }] of list.entries()) {
      const rows = overview.groups
      const root = rows.find((row) => row[1] === null)
      if (!root) continue
      const old = previous.get(name)
      if (old && old.version !== overview.version) this.dropSpace(name)
      this.spaces.push({ name, index, root: root[0], ox: 0, oy: 0, r: root[8], version: overview.version, pairs: overview.links })
      this.addGroups(name, index, rows)
    }
    for (const gone of previous.keys()) if (!list.some((item) => item.name === gone)) this.dropSpace(gone)
    const offsets = pack(this.spaces.map((s) => s.r))
    for (const [i, space] of this.spaces.entries()) {
      space.ox = offsets[i].x
      space.oy = offsets[i].y
    }
    for (const group of this.groups.values()) {
      const space = this.space(group.space)!
      group.x += space.ox
      group.y += space.oy
    }
    for (const note of this.notes.values()) this.place(note)
    this.byRadius = [...this.groups.values()].sort((a, b) => a.r - b.r)
  }

  private addGroups(space: string, index: number, rows: GroupRow[]) {
    const byId = new Map<number, GroupRow>(rows.map((row) => [row[0], row]))
    const depthOf = (row: GroupRow): number => {
      let depth = 1
      for (let p = row[1]; p !== null; p = byId.get(p)?.[1] ?? null) depth++
      return depth
    }
    for (const row of rows) {
      const [id, parent, kind, name, total, daily, x, y, r, slot, key, level] = row
      const parentRow = parent !== null ? byId.get(parent) : undefined
      this.groups.set(id, {
        id, space, parent, kind, name, key, total, daily, own: total, x, y, r, level,
        color: kind === 'space' ? spaceColor(index) : slotColor(slot),
        depth: depthOf(row), children: [], parentR: parentRow ? parentRow[8] : 0,
      })
    }
    for (const row of rows) {
      const group = this.groups.get(row[0])!
      if (row[1] !== null) {
        const parent = this.groups.get(row[1])
        if (parent) {
          parent.children.push(group.id)
          parent.own -= group.total
        }
      }
    }
  }

  private dropSpace(name: string) {
    for (const [key, tile] of this.tiles) if (tile.space === name) this.tiles.delete(key)
    for (const [id, note] of this.notes) if (note.space === name) this.notes.delete(id)
    for (const [id, other] of this.others) if (other.space === name) this.others.delete(id)
    this.pruneLinks()
  }

  space(name: string): SpaceState | undefined {
    return this.spaces.find((s) => s.name === name)
  }

  private place(note: { space: string; lx: number; ly: number; x?: number; y?: number }) {
    const space = this.space(note.space)
    note.x = note.lx + (space?.ox ?? 0)
    note.y = note.ly + (space?.oy ?? 0)
  }

  tileKey(space: string, level: number, x: number, y: number): string {
    return `${space}|${this.space(space)?.version ?? 0}|${level}:${x}:${y}`
  }

  /** Tiles as the server sent them. `version`: the map's version when they were asked for; an answer to an older
   * version is dropped (its places are those of the old map, and it would count as loaded for the new one). */
  addTiles(space: string, version: number, keys: string[], data: Tiles) {
    const state = this.space(space)
    if (!state || state.version !== version) return
    for (const tile of data.tiles) {
      const key = this.tileKey(space, tile.level, tile.x, tile.y)
      const ids: number[] = []
      for (const row of tile.notes) {
        ids.push(row[0])
        this.notes.set(row[0], this.noteFrom(space, row))
        this.others.delete(row[0])
      }
      this.tiles.set(key, { key, space, ids, used: ++this.clock })
    }
    // A tile that came back empty is loaded too: nothing to ask for again.
    for (const key of keys) if (!this.tiles.has(key)) this.tiles.set(key, { key, space, ids: [], used: ++this.clock })
    for (const [id, group] of data.others) {
      if (!this.notes.has(id)) this.others.set(id, { id, space, group })
    }
    for (const [a, b] of data.links) this.links.set(a < b ? `${a}|${b}` : `${b}|${a}`, a < b ? [a, b] : [b, a])
    this.evict()
  }

  private noteFrom(space: string, row: TileNote): SceneNote {
    const [id, group, lx, ly, r, daily, title, path] = row
    const note: SceneNote = { id, space, group, lx, ly, x: lx, y: ly, r, daily: daily === 1, title, path }
    this.place(note)
    return note
  }

  touch(keys: Iterable<string>) {
    this.inView = this.clock + 1
    for (const key of keys) {
      const tile = this.tiles.get(key)
      if (tile) tile.used = ++this.clock
    }
  }

  private evict() {
    if (this.tiles.size <= MAX_TILES) return
    // Only tiles out of view go; with more in view than the limit, the limit waits.
    const oldest = [...this.tiles.values()]
      .filter((tile) => tile.used < this.inView)
      .sort((a, b) => a.used - b.used)
      .slice(0, this.tiles.size - MAX_TILES)
    for (const tile of oldest) {
      this.tiles.delete(tile.key)
      for (const id of tile.ids) this.notes.delete(id)
    }
    this.pruneLinks()
  }

  private pruneLinks() {
    for (const [key, [a, b]] of this.links) if (!this.notes.has(a) && !this.notes.has(b)) this.links.delete(key)
  }

  // --- Which tiles the view needs -----------------------------------------------------------------------------------

  /** Tiles of each space for what is on screen (plus a margin), at the levels whose notes can be seen at this zoom. */
  wanted(camera: Camera, width: number, height: number, tileSize: number): Map<string, { space: string; tile: string; key: string }[]> {
    const margin = 0.35
    const halfW = (width / 2 / camera.k) * (1 + margin)
    const halfH = (height / 2 / camera.k) * (1 + margin)
    const x0 = camera.x - halfW
    const x1 = camera.x + halfW
    const y0 = camera.y - halfH
    const y1 = camera.y + halfH
    const out = new Map<string, { space: string; tile: string; key: string }[]>()
    const seen = new Set<string>()
    for (const group of this.groups.values()) {
      if (group.own <= 0) continue
      // A little before the group starts to open, so the dots are there when they fade in.
      if (group.r * camera.k < OPEN_FROM * 0.8) continue
      if (this.hidden(group)) continue
      const gx0 = Math.max(x0, group.x - group.r)
      const gx1 = Math.min(x1, group.x + group.r)
      const gy0 = Math.max(y0, group.y - group.r)
      const gy1 = Math.min(y1, group.y + group.r)
      if (gx0 > gx1 || gy0 > gy1) continue
      const space = this.space(group.space)!
      const size = tileSize / 2 ** group.level
      const tx0 = Math.floor((gx0 - space.ox) / size)
      const tx1 = Math.floor((gx1 - space.ox) / size)
      const ty0 = Math.floor((gy0 - space.oy) / size)
      const ty1 = Math.floor((gy1 - space.oy) / size)
      for (let tx = tx0; tx <= tx1; tx++) {
        for (let ty = ty0; ty <= ty1; ty++) {
          const tile = `${group.level}:${tx}:${ty}`
          const key = `${group.space}|${space.version}|${tile}`
          if (seen.has(key)) continue
          seen.add(key)
          const list = out.get(group.space) ?? []
          list.push({ space: group.space, tile, key })
          out.set(group.space, list)
        }
      }
    }
    return out
  }

  // --- Semantic zoom ------------------------------------------------------------------------------------------------

  /** How many groups are closed at this zoom: the representative of every note follows from it alone. */
  band(k: number): number {
    const limit = MID / k
    let low = 0
    let high = this.byRadius.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (this.byRadius[mid].r < limit) low = mid + 1
      else high = mid
    }
    return low
  }

  /** The outermost closed group around a group at zoom `k`, or -1 when the group itself is open. */
  representative(groupId: number, k: number, memo?: Map<number, number>): number {
    const known = memo?.get(groupId)
    if (known !== undefined) return known
    const chain: SceneGroup[] = []
    for (let g = this.groups.get(groupId); g; g = g.parent !== null ? this.groups.get(g.parent) : undefined) chain.push(g)
    let found = -1
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].r * k < MID) {
        found = chain[i].id
        break
      }
    }
    memo?.set(groupId, found)
    return found
  }

  hidden(group: SceneGroup): boolean {
    return this.hideDaily && group.daily > 0 && group.daily === group.total
  }

  // --- Buffers for gl.ts ------------------------------------------------------------------------------------------

  /** Notes as points, and the order they are in (for the flags). */
  pointBuffer(): { data: ArrayBuffer; ids: number[] } {
    const ids = [...this.notes.keys()]
    const data = new ArrayBuffer(ids.length * POINT_STRIDE)
    const f32 = new Float32Array(data)
    const u8 = new Uint8Array(data)
    const perVertex = POINT_STRIDE / 4
    ids.forEach((id, i) => {
      const note = this.notes.get(id)!
      const home = this.groups.get(note.group)
      f32[i * perVertex] = note.x
      f32[i * perVertex + 1] = note.y
      f32[i * perVertex + 2] = note.r
      f32[i * perVertex + 3] = home ? home.r : 0
      const [r, g, b] = rgba(home?.color ?? '#9a9aa8')
      u8[i * POINT_STRIDE + 16] = r
      u8[i * POINT_STRIDE + 17] = g
      u8[i * POINT_STRIDE + 18] = b
      u8[i * POINT_STRIDE + 19] = 255
    })
    return { data, ids }
  }

  /** Flags of the points: [spare, ring (focus or chosen), hidden, next to the focus]. */
  pointFlags(ids: number[], focus: number | null, chosen: number | null, near: Set<number>): Uint8Array {
    const flags = new Uint8Array(ids.length * 4)
    ids.forEach((id, i) => {
      const note = this.notes.get(id)!
      const group = this.groups.get(note.group)
      flags[i * 4 + 1] = id === focus || id === chosen ? 255 : 0
      flags[i * 4 + 2] = (this.hideDaily && note.daily) || (group && this.hidden(group)) ? 255 : 0
      flags[i * 4 + 3] = near.has(id) ? 255 : 0
    })
    return flags
  }

  bubbleBuffer(): { data: ArrayBuffer; ids: number[] } {
    const ids = [...this.groups.values()].sort((a, b) => a.depth - b.depth || a.id - b.id).map((g) => g.id)
    const corners = [-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]
    const data = new ArrayBuffer(ids.length * 6 * BUBBLE_STRIDE)
    const f32 = new Float32Array(data)
    const u8 = new Uint8Array(data)
    const per = BUBBLE_STRIDE / 4
    ids.forEach((id, i) => {
      const group = this.groups.get(id)!
      const [r, g, b] = rgba(group.color)
      for (let v = 0; v < 6; v++) {
        const at = (i * 6 + v) * per
        f32[at] = corners[v * 2]
        f32[at + 1] = corners[v * 2 + 1]
        f32[at + 2] = group.x
        f32[at + 3] = group.y
        f32[at + 4] = group.r
        f32[at + 5] = group.parentR
        const byte = (i * 6 + v) * BUBBLE_STRIDE + 24
        u8[byte] = r
        u8[byte + 1] = g
        u8[byte + 2] = b
        u8[byte + 3] = 255
      }
    })
    return { data, ids }
  }

  /** Flags of the circles: [hovered, holds the focus or a neighbour, dashed border, hidden]. */
  bubbleFlags(ids: number[], hover: number | null, marked: Set<number>): Uint8Array {
    const flags = new Uint8Array(ids.length * 6 * 4)
    ids.forEach((id, i) => {
      const group = this.groups.get(id)!
      const values = [id === hover ? 255 : 0, marked.has(id) ? 255 : 0, group.depth > 2 ? 255 : 0, this.hidden(group) ? 255 : 0]
      for (let v = 0; v < 6; v++) flags.set(values, (i * 6 + v) * 4)
    })
    return flags
  }

  private end(kind: 'note' | 'group', id: number): { x: number; y: number; kind: number; r: number; rp: number } | null {
    if (kind === 'group') {
      const g = this.groups.get(id)
      return g ? { x: g.x, y: g.y, kind: 1, r: g.r, rp: g.parentR } : null
    }
    const note = this.notes.get(id)
    if (note) return { x: note.x, y: note.y, kind: 0, r: this.groups.get(note.group)?.r ?? 0, rp: 0 }
    return null
  }

  /**
   * Lines at zoom `k`: thin ones between two visible notes, bands from a note to a closed group and between closed
   * groups (one per pair, wider for more links), and the links of the focus drawn hot. With more than `MANY_LINES`
   * lines from notes, only the focus's are drawn; the bundles between closed groups stay.
   */
  lineBuffers(k: number, focus: number | null): { lines: ArrayBuffer; lineCount: number; bands: ArrayBuffer; bandCount: number } {
    const memo = new Map<number, number>()
    const bundles = new Map<string, { a: [string, number]; b: [string, number]; count: number; hot: boolean }>()
    const thin: [number, number][] = []
    const hiddenGroup = (id: number) => {
      const group = this.groups.get(id)
      return !group || this.hidden(group)
    }
    const add = (a: [string, number], b: [string, number], count: number, hot: boolean) => {
      const ka = a[0] + a[1]
      const kb = b[0] + b[1]
      const key = ka < kb ? ka + '|' + kb : kb + '|' + ka
      const bundle = bundles.get(key) ?? { a, b, count: 0, hot: false }
      bundle.count += count
      bundle.hot ||= hot
      bundles.set(key, bundle)
    }
    // Between closed groups: from the counts of the overview.
    for (const space of this.spaces) {
      for (const [ga, gb, count] of space.pairs) {
        if (hiddenGroup(ga) || hiddenGroup(gb)) continue
        const ra = this.representative(ga, k, memo)
        const rb = this.representative(gb, k, memo)
        if (ra < 0 || rb < 0 || ra === rb) continue
        add(['g', ra], ['g', rb], count, false)
      }
    }
    // From visible notes: to another visible note, or to the closed group the other end is in.
    const calm: { a: number; b: number; ea: [string, number]; eb: [string, number] }[] = []
    for (const [a, b] of this.links.values()) {
      const ends: ([string, number] | null)[] = [a, b].map((id) => {
        const note = this.notes.get(id)
        const group = note?.group ?? this.others.get(id)?.group
        if (group === undefined || hiddenGroup(group) || (note && this.hideDaily && note.daily)) return null
        const rep = this.representative(group, k, memo)
        if (rep >= 0) return ['g', rep]
        return note ? ['n', id] : null
      })
      const [ea, eb] = ends
      if (!ea || !eb) continue
      if (ea[0] === 'g' && eb[0] === 'g') continue // counted between the groups above
      if (ea[0] === eb[0] && ea[1] === eb[1]) continue
      const hot = focus !== null && (a === focus || b === focus)
      if (hot) add(ea, eb, 1, true)
      else calm.push({ a, b, ea, eb })
    }
    if (calm.length <= MANY_LINES) {
      for (const { a, b, ea, eb } of calm) {
        if (ea[0] === 'n' && eb[0] === 'n') thin.push([a, b])
        else add(ea, eb, 1, false)
      }
    }

    const lines = new ArrayBuffer(thin.length * 2 * LINE_STRIDE)
    const lf = new Float32Array(lines)
    let n = 0
    for (const [a, b] of thin) {
      const ea = this.end('note', a)!
      const eb = this.end('note', b)!
      for (const [self, other] of [
        [ea, eb],
        [eb, ea],
      ]) {
        lf.set([self.x, self.y, self.kind, self.r, self.rp, other.kind, other.r, other.rp], n * 8)
        n++
      }
    }

    const list = [...bundles.values()]
    const bands = new ArrayBuffer(list.length * 6 * BAND_STRIDE)
    const bf = new Float32Array(bands)
    const corners = [0, -1, 1, -1, 0, 1, 0, 1, 1, -1, 1, 1]
    let m = 0
    for (const bundle of list) {
      const ea = this.end(bundle.a[0] === 'g' ? 'group' : 'note', bundle.a[1])
      const eb = this.end(bundle.b[0] === 'g' ? 'group' : 'note', bundle.b[1])
      if (!ea || !eb) continue
      const width = bundle.hot ? 1.8 : Math.min(7, 1 + Math.log2(bundle.count) * 1.3)
      for (let v = 0; v < 6; v++) {
        bf.set(
          [corners[v * 2], corners[v * 2 + 1], ea.x, ea.y, eb.x, eb.y, ea.kind, ea.r, ea.rp, eb.kind, eb.r, eb.rp, width, bundle.hot ? 1 : 0],
          m * (BAND_STRIDE / 4),
        )
        m++
      }
    }
    return { lines, lineCount: n, bands, bandCount: m }
  }

  // --- Focus --------------------------------------------------------------------------------------------------------

  neighbours(id: number): Set<number> {
    const found = new Set<number>()
    for (const [a, b] of this.links.values()) {
      if (a === id) found.add(b)
      else if (b === id) found.add(a)
    }
    return found
  }

  /** Groups that hold the focus or one of its neighbours: their closed bubbles get a ring. */
  markedGroups(ids: Iterable<number>): Set<number> {
    const marked = new Set<number>()
    for (const id of ids) {
      let group = this.notes.get(id)?.group ?? this.others.get(id)?.group
      while (group !== undefined && group !== null) {
        marked.add(group)
        group = this.groups.get(group)?.parent ?? undefined
      }
    }
    return marked
  }

  // --- Hits and labels ----------------------------------------------------------------------------------------------

  noteAlpha(note: SceneNote, k: number): number {
    const home = this.groups.get(note.group)
    if (!home || this.hidden(home) || (this.hideDaily && note.daily)) return 0
    return inner(openness(home.r, k))
  }

  groupAlpha(group: SceneGroup, k: number): { closed: number; open: number } {
    if (this.hidden(group)) return { closed: 0, open: 0 }
    const o = openness(group.r, k)
    const vis = inner(openness(group.parentR, k))
    return { closed: shell(o) * vis, open: ring(o) * vis }
  }

  /** The note or closed group under a point of the screen. */
  hit(px: number, py: number, camera: Camera, width: number, height: number): { kind: 'note' | 'group'; id: number } | null {
    const wx = (px - width / 2) / camera.k + camera.x
    const wy = (py - height / 2) / camera.k + camera.y
    let best: number | null = null
    let bestDistance = Infinity
    for (const note of this.notes.values()) {
      if (this.noteAlpha(note, camera.k) < 0.35) continue
      const dot = Math.min(MAX_DOT, Math.max(MIN_DOT, note.r * camera.k))
      const d = Math.hypot(note.x - wx, note.y - wy) * camera.k
      if (d < Math.max(dot, 6) + 4 && d < bestDistance) {
        bestDistance = d
        best = note.id
      }
    }
    if (best !== null) return { kind: 'note', id: best }
    let deepest: SceneGroup | null = null
    for (const group of this.groups.values()) {
      if (this.groupAlpha(group, camera.k).closed < 0.35) continue
      if (Math.hypot(group.x - wx, group.y - wy) < group.r && (!deepest || group.depth > deepest.depth)) deepest = group
    }
    return deepest ? { kind: 'group', id: deepest.id } : null
  }

  /** The deepest open group under the middle of the screen, for the breadcrumb. */
  centre(camera: Camera): SceneGroup | null {
    let found: SceneGroup | null = null
    for (const group of this.groups.values()) {
      if (openness(group.r, camera.k) < 0.5) continue
      if (Math.hypot(group.x - camera.x, group.y - camera.y) >= group.r) continue
      if (!found || group.depth > found.depth) found = group
    }
    return found
  }
}
