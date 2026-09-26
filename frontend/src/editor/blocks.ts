/**
 * Only the blocks somebody changed are written anew; everything else stays byte for byte as it was on disk.
 *
 * No Markdown editor keeps a file exactly: it parses it into its own model and writes that model back in its own
 * style. So this does not compare the original with the editor's output, but two outputs of the same editor:
 *
 *   O   the text from disk
 *   E0  what the editor writes for O when nobody changed anything
 *   E1  what the editor writes now, after the changes
 *
 * 1. O and E0 are cut into units. A block of O belongs to the E0 blocks the editor turns it into (each O block is
 *    run through the editor on its own and compared, 1 to up to 4). What cannot be matched forms a shared unit
 *    between two safe anchors. A block the editor writes as nothing keeps a unit of its own, so it is never lost.
 * 2. E0 against E1, block by block (longest common subsequence). Unchanged blocks are equal as text, because the
 *    same editor wrote them.
 * 3. A unit whose E0 blocks all stand unchanged in E1 is copied from O, including the space to a neighbouring copied
 *    unit. Everything else comes from E1.
 *
 * Without a change E1 = E0, every unit is clean, and the result is O itself, line endings and end of file included,
 * however lossy the editor is.
 */

export type Block = { start: number; end: number }
type Unit = { oFrom: number; oTo: number; e0: number[] }

export type Tools = {
  /** Top-level blocks of a Markdown text with their offsets, as the editor's parser sees them. */
  blocks: (text: string) => Block[]
  /** The editor's round trip for a piece of Markdown: parse into its model, write it back. */
  serialize: (text: string) => string
}

/** Above this many cells a table is not built; the part in between becomes one unit (never loses anything). */
const MAX_CELLS = 2_000_000
const SPAN = 4

const norm = (text: string) => text.replace(/\r\n?/g, '\n').trim()

/** Matching O to E0. Worked out once per original and reused for every save. */
export class Plan {
  readonly original: string
  readonly e0: string
  readonly o: Block[]
  readonly e0Blocks: Block[]
  readonly e0Texts: string[]
  readonly units: Unit[]
  /** O blocks the editor writes as nothing (it has no node for them). */
  readonly empty: boolean[]
  readonly eol: string

  constructor(original: string, tools: Tools) {
    this.original = original
    this.eol = original.includes('\r\n') ? '\r\n' : '\n'
    this.e0 = tools.serialize(original)
    this.o = tools.blocks(original)
    this.e0Blocks = tools.blocks(this.e0)
    this.e0Texts = this.e0Blocks.map((block) => norm(this.e0.slice(block.start, block.end)))
    const canon = this.o.map((block) => norm(tools.serialize(original.slice(block.start, block.end))))
    this.empty = canon.map((text) => !text)
    this.units = splitEmpty(matchUnits(canon, this.e0, this.e0Blocks))
  }

  /** The text to write for the editor's output `edited`. */
  apply(edited: string, tools: Pick<Tools, 'blocks'>): string {
    return assemble(this, edited, tools.blocks(edited))
  }
}

function matchUnits(canon: string[], e0Text: string, e0: Block[]): Unit[] {
  const n = canon.length
  const m = e0.length
  const joined: string[][] = e0.map((_, j) =>
    Array.from({ length: Math.min(SPAN, m - j) }, (_, k) => norm(e0Text.slice(e0[j].start, e0[j + k].end))),
  )
  const takeAt = (i: number, j: number): number => {
    if (!canon[i]) return 0
    const row = joined[j] ?? []
    for (let k = 0; k < row.length; k++) if (row[k] === canon[i]) return k + 1
    return 0
  }
  const anchors: Unit[] = []
  // Most blocks match one to one: take them greedily from both ends, the table is only for the part in between.
  let i0 = 0
  let j0 = 0
  for (let k: number; i0 < n && j0 < m && (k = takeAt(i0, j0)); i0++, j0 += k) {
    anchors.push({ oFrom: i0, oTo: i0 + 1, e0: range(j0, k) })
  }
  const tail: Unit[] = []
  let i1 = n
  let j1 = m
  while (i1 > i0 && j1 > j0) {
    let found = 0
    for (let k = 1; k <= SPAN && j1 - k >= j0; k++) {
      if (canon[i1 - 1] && joined[j1 - k]?.[k - 1] === canon[i1 - 1]) {
        found = k
        break
      }
    }
    if (!found) break
    tail.unshift({ oFrom: i1 - 1, oTo: i1, e0: range(j1 - found, found) })
    i1 -= 1
    j1 -= found
  }
  const middle = middleUnits(i0, i1, j0, j1, takeAt)
  return [...anchors, ...middle, ...tail]
}

/** The part between the greedy ends: a table of how many O blocks can be matched at most from (i, j) on. */
function middleUnits(i0: number, i1: number, j0: number, j1: number, takeAt: (i: number, j: number) => number): Unit[] {
  const n = i1 - i0
  const m = j1 - j0
  if (!n && !m) return []
  if (n * m > MAX_CELLS || !n || !m) return [{ oFrom: i0, oTo: i1, e0: range(j0, m) }]
  const best = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  const take = Array.from({ length: n + 1 }, () => new Int8Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m; j >= 0; j--) {
      let value = Math.max(best[i + 1][j], j < m ? best[i][j + 1] : 0)
      let chosen = 0
      if (j < m) {
        const k = takeAt(i0 + i, j0 + j)
        if (k && j + k <= m && 1 + best[i + 1][j + k] > value) {
          value = 1 + best[i + 1][j + k]
          chosen = k
        }
      }
      best[i][j] = value
      take[i][j] = chosen
    }
  }
  const result: Unit[] = []
  let i = 0
  let j = 0
  let gapFrom = 0
  let gapE: number[] = []
  const flush = (to: number) => {
    if (gapFrom < to || gapE.length) result.push({ oFrom: i0 + gapFrom, oTo: i0 + to, e0: gapE })
    gapE = []
  }
  while (i < n || j < m) {
    if (i < n && j < m && take[i][j] > 0) {
      flush(i)
      const k = take[i][j]
      result.push({ oFrom: i0 + i, oTo: i0 + i + 1, e0: range(j0 + j, k) })
      i += 1
      j += k
      gapFrom = i
    } else if (i < n && (j >= m || best[i + 1][j] >= best[i][j + 1])) {
      i += 1
    } else {
      gapE.push(j0 + j)
      j += 1
    }
  }
  flush(n)
  return result
}

/** The O blocks of a gap without any E0 block get a unit each: each is kept as long as nothing around it goes. */
function splitEmpty(units: Unit[]): Unit[] {
  return units.flatMap((unit) =>
    unit.e0.length === 0 && unit.oTo - unit.oFrom > 1
      ? range(unit.oFrom, unit.oTo - unit.oFrom).map((i) => ({ oFrom: i, oTo: i + 1, e0: [] }))
      : [unit],
  )
}

function range(from: number, count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, (_, x) => from + x)
}

/** Longest common subsequence over block texts: for each E0 block the matching E1 block, or -1. */
function matchBlocks(a: string[], b: string[]): number[] {
  const match = new Array<number>(a.length).fill(-1)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) {
    match[start] = start
    start++
  }
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    match[endA - 1] = endB - 1
    endA--
    endB--
  }
  const n = endA - start
  const m = endB - start
  if (!n || !m || n * m > MAX_CELLS) return match
  const table = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i][j] = a[start + i] === b[start + j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      match[start + i] = start + j
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) i++
    else j++
  }
  return match
}

type Segment = { from: 'o'; first: number; last: number } | { from: 'e1'; block: number }

function assemble(plan: Plan, edited: string, e1: Block[]): string {
  const { original, o, units, eol, empty } = plan
  const e1Texts = e1.map((block) => norm(edited.slice(block.start, block.end)))
  const match = matchBlocks(plan.e0Texts, e1Texts)

  // E1 blocks without an E0 counterpart are placed after the last matched E0 block before them.
  const insertedAfter = new Map<number, number[]>()
  const e1ToE0 = new Map<number, number>()
  match.forEach((l, j) => l >= 0 && e1ToE0.set(l, j))
  let lastE0 = -1
  for (let l = 0; l < e1.length; l++) {
    if (e1ToE0.has(l)) lastE0 = e1ToE0.get(l)!
    else insertedAfter.set(lastE0, [...(insertedAfter.get(lastE0) ?? []), l])
  }

  const segments: Segment[] = []
  const pushNew = (list: number[] | undefined) => list?.forEach((l) => segments.push({ from: 'e1', block: l }))
  pushNew(insertedAfter.get(-1))
  for (const unit of units) {
    const inner = unit.e0.slice(0, -1)
    const clean = unit.e0.every((j) => match[j] >= 0) && inner.every((j) => !insertedAfter.has(j))
    if (clean) {
      if (unit.oTo > unit.oFrom) segments.push({ from: 'o', first: unit.oFrom, last: unit.oTo - 1 })
    } else {
      for (const j of unit.e0) {
        if (match[j] >= 0) segments.push({ from: 'e1', block: match[j] })
        if (j !== unit.e0.at(-1)) pushNew(insertedAfter.get(j))
      }
      // What the editor cannot show is not in E1 either; it stays, after the unit's new text.
      for (let i = unit.oFrom; i < unit.oTo; i++) if (empty[i]) segments.push({ from: 'o', first: i, last: i })
    }
    if (unit.e0.length) pushNew(insertedAfter.get(unit.e0.at(-1)!))
  }

  const lines = (text: string) => text.replace(/\r?\n/g, eol)
  let out = ''
  segments.forEach((segment, k) => {
    const previous = segments[k - 1]
    if (k === 0) {
      // Space before the first block (blank lines at the top) stays when that block is still the first.
      if (o.length && (segment.from === 'e1' || segment.first === 0)) out += original.slice(0, o[0].start)
    } else if (segment.from === 'o' && previous.from === 'o' && segment.first === previous.last + 1) {
      out += original.slice(o[previous.last].end, o[segment.first].start)
    } else if (segment.from === 'e1' && previous.from === 'e1' && segment.block === previous.block + 1) {
      out += lines(edited.slice(e1[previous.block].end, e1[segment.block].start))
    } else out += eol + eol
    out +=
      segment.from === 'o'
        ? original.slice(o[segment.first].start, o[segment.last].end)
        : lines(edited.slice(e1[segment.block].start, e1[segment.block].end))
  })
  const last = segments.at(-1)
  if (!last) return ''
  if (last.from === 'o' && last.last === o.length - 1) out += original.slice(o[o.length - 1].end)
  else out += eol
  return out
}
