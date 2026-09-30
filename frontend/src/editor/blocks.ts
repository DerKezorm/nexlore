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
 *    unit. Everything else comes from E1, except a block that only moved: new at its place in E1, but unchanged
 *    and a unit of its own in E0, it is copied from O too.
 *
 * Without a change E1 = E0, every unit is clean, and the result is O itself, line endings and end of file included,
 * however lossy the editor is.
 *
 * 4. A changed block that was one block in O and in E0 is merged line by line (`mergeLines`): a line the change did
 *    not touch is taken from O, so a word changed in a table or a callout leaves the other rows as they were written.
 *    Only when the merged block reads exactly like the editor's own (its round trip is the same); else E1's block.
 * 5. What follows the last block (blank lines, or no line break at all) is the file's own and stays.
 */

export type Block = { start: number; end: number }
type Unit = { oFrom: number; oTo: number; e0: number[] }

export type Tools = {
  /** Top-level blocks of a Markdown text with their offsets, as the editor's parser sees them. */
  blocks: (text: string) => Block[]
  /** The editor's round trip for a piece of Markdown: parse into its model, write it back. */
  serialize: (text: string) => string
}

/** Above this many cells a table is not built; matching walks with a window instead (see `windowUnits`). */
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

  /** `maxCells`: for tests, to reach the windowed matching with small texts. */
  readonly maxCells: number

  constructor(original: string, tools: Tools, maxCells = MAX_CELLS) {
    this.maxCells = maxCells
    this.original = original
    this.eol = original.includes('\r\n') ? '\r\n' : '\n'
    this.e0 = tools.serialize(original)
    this.o = tools.blocks(original)
    this.e0Blocks = tools.blocks(this.e0)
    this.e0Texts = this.e0Blocks.map((block) => norm(this.e0.slice(block.start, block.end)))
    const canon = this.o.map((block) => norm(tools.serialize(original.slice(block.start, block.end))))
    this.empty = canon.map((text) => !text)
    this.units = splitEmpty(matchUnits(canon, this.e0, this.e0Blocks, maxCells))
  }

  /** The text to write for the editor's output `edited`. With `serialize`, changed blocks are merged line by line. */
  apply(edited: string, tools: Pick<Tools, 'blocks'> & Partial<Pick<Tools, 'serialize'>>): string {
    return assemble(this, edited, tools.blocks(edited), tools.serialize)
  }
}

function matchUnits(canon: string[], e0Text: string, e0: Block[], maxCells: number): Unit[] {
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
  const middle = middleUnits(i0, i1, j0, j1, takeAt, maxCells)
  return [...anchors, ...middle, ...tail]
}

/**
 * Too large for the table (a very long note whose early block the editor writes differently): matching walks
 * forward and looks for the next anchor within a window on either side. Linear, and misses only anchors that moved
 * far; what it misses becomes part of a gap, never lost.
 */
function windowUnits(i0: number, i1: number, j0: number, j1: number, takeAt: (i: number, j: number) => number): Unit[] {
  const WINDOW = 64
  const result: Unit[] = []
  let gapFrom = i0
  let gapE: number[] = []
  const flush = (to: number) => {
    if (gapFrom < to || gapE.length) result.push({ oFrom: gapFrom, oTo: to, e0: gapE })
    gapE = []
  }
  let i = i0
  let j = j0
  while (i < i1 && j < j1) {
    const k = takeAt(i, j)
    if (k && j + k <= j1) {
      flush(i)
      result.push({ oFrom: i, oTo: i + 1, e0: range(j, k) })
      i += 1
      j += k
      gapFrom = i
      continue
    }
    // The nearest anchor ahead: E0 blocks skipped (the editor wrote more), or O blocks skipped (it wrote less).
    let skipE = 0
    let skipO = 0
    for (let d = 1; d <= WINDOW && !skipE && !skipO; d++) {
      if (j + d < j1 && takeAt(i, j + d)) skipE = d
      else if (i + d < i1 && takeAt(i + d, j)) skipO = d
    }
    if (skipE) {
      gapE.push(...range(j, skipE))
      j += skipE
    } else if (skipO) i += skipO
    else {
      gapE.push(j)
      i += 1
      j += 1
    }
  }
  gapE.push(...range(j, j1 - j))
  flush(i1)
  return result
}

/** The part between the greedy ends: a table of how many O blocks can be matched at most from (i, j) on. */
function middleUnits(i0: number, i1: number, j0: number, j1: number, takeAt: (i: number, j: number) => number, maxCells: number): Unit[] {
  const n = i1 - i0
  const m = j1 - j0
  if (!n && !m) return []
  if (!n || !m) return [{ oFrom: i0, oTo: i1, e0: range(j0, m) }]
  if (n * m > maxCells) return windowUnits(i0, i1, j0, j1, takeAt)
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
function matchBlocks(a: string[], b: string[], maxCells: number): number[] {
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
  if (!n || !m) return match
  if (n * m > maxCells) {
    // Too large for the table (changes far apart in a very long note): walk, and look ahead within a window.
    const WINDOW = 64
    let i = start
    let j = start
    while (i < endA && j < endB) {
      if (a[i] === b[j]) {
        match[i++] = j++
        continue
      }
      let skipB = 0
      let skipA = 0
      for (let d = 1; d <= WINDOW && !skipA && !skipB; d++) {
        if (j + d < endB && a[i] === b[j + d]) skipB = d
        else if (i + d < endA && a[i + d] === b[j]) skipA = d
      }
      if (skipB) j += skipB
      else if (skipA) i += skipA
      else {
        i++
        j++
      }
    }
    return match
  }
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

type Segment = { from: 'o'; first: number; last: number } | { from: 'e1'; block: number; o?: number; e0?: number }

/** Above this many line pairs a block is not merged line by line (the table would grow too large). */
const MAX_LINE_CELLS = 250_000

/** A line as it reads, not as it is written: blanks around pipes, the dashes of a delimiter row, escapes, the marks
 * of a hard break at its end. */
function plainLine(line: string): string {
  return line
    .replace(/(?:\\| {2,})$/, '')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/\s*\|\s*/g, '|')
    .replace(/-+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Pairs (index in a, index in b) of a longest common subsequence of equal lines. */
function commonLines(a: string[], b: string[]): [number, number][] {
  const table = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
  const pairs: [number, number][] = []
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) pairs.push([i++, j++])
    else if (table[i + 1][j] >= table[i][j + 1]) i++
    else j++
  }
  return pairs
}

/**
 * One changed block, line by line: a line the editor writes the same before and after the change comes from the
 * original where the original has it (as it reads), and a blank line only the editor writes (`>` between a
 * paragraph and a list in a quote) stays out. Every other line is the editor's.
 */
export function mergeLines(original: string, before: string, after: string, eol: string): string {
  const o = original.split(/\r?\n/)
  const e0 = before.split('\n')
  const e1 = after.split('\n')
  if (o.length * e0.length > MAX_LINE_CELLS || e0.length * e1.length > MAX_LINE_CELLS) return after.replace(/\n/g, eol)
  const toO = new Map(commonLines(e0.map(plainLine), o.map(plainLine)))
  const kept = new Map(commonLines(e1, e0))
  const out: string[] = []
  e1.forEach((line, l) => {
    const j = kept.get(l)
    if (j === undefined) out.push(line)
    else if (toO.has(j)) out.push(o[toO.get(j)!])
    else if (!/^[>\s]*$/.test(e0[j])) out.push(line)
  })
  return out.join(eol)
}

function assemble(plan: Plan, edited: string, e1: Block[], serialize?: Tools['serialize']): string {
  const { original, o, units, eol, empty } = plan
  const e1Texts = e1.map((block) => norm(edited.slice(block.start, block.end)))
  const match = matchBlocks(plan.e0Texts, e1Texts, plan.maxCells)

  // E1 blocks without an E0 counterpart are placed after the last matched E0 block before them.
  const insertedAfter = new Map<number, number[]>()
  const e1ToE0 = new Map<number, number>()
  match.forEach((l, j) => l >= 0 && e1ToE0.set(l, j))
  let lastE0 = -1
  for (let l = 0; l < e1.length; l++) {
    if (e1ToE0.has(l)) lastE0 = e1ToE0.get(l)!
    else insertedAfter.set(lastE0, [...(insertedAfter.get(lastE0) ?? []), l])
  }

  // A block that only moved (dragged by its grip, cut and pasted) is new in E1 but stands unchanged in E0 elsewhere:
  // when it is a unit of its own, its original text goes to the new place, not the editor's way of writing it.
  const moved = new Map<number, Unit>()
  const unitOf = new Map<number, Unit>()
  for (const unit of units) if (unit.e0.length === 1) unitOf.set(unit.e0[0], unit)
  const left = new Map<string, number[]>()
  plan.e0Texts.forEach((text, j) => match[j] < 0 && unitOf.has(j) && left.set(text, [...(left.get(text) ?? []), j]))
  for (const list of insertedAfter.values())
    for (const l of list) {
      const j = left.get(e1Texts[l])?.shift()
      if (j !== undefined) moved.set(l, unitOf.get(j)!)
    }

  // A block changed in place: one O block, one E0 block, and in E1 one new block where it stood, with unchanged
  // neighbours on both sides. Written merged line by line (see `mergeLines`).
  const replaced = new Map<number, { o: number; e0: number }>()
  for (const unit of units) {
    if (unit.oTo - unit.oFrom !== 1 || unit.e0.length !== 1 || empty[unit.oFrom]) continue
    const j = unit.e0[0]
    const before = j === 0 ? -1 : j - 1
    const list = insertedAfter.get(before)
    if (match[j] >= 0 || (before >= 0 && match[before] < 0) || (j + 1 < match.length && match[j + 1] < 0)) continue
    if (list?.length === 1 && !moved.has(list[0])) replaced.set(list[0], { o: unit.oFrom, e0: j })
  }

  const segments: Segment[] = []
  const pushNew = (list: number[] | undefined) =>
    list?.forEach((l) => {
      const unit = moved.get(l)
      const was = replaced.get(l)
      if (unit && unit.oTo > unit.oFrom) segments.push({ from: 'o', first: unit.oFrom, last: unit.oTo - 1 })
      else segments.push(was ? { from: 'e1', block: l, ...was } : { from: 'e1', block: l })
    })
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
  const written = (segment: Extract<Segment, { from: 'e1' }>): string => {
    const text = edited.slice(e1[segment.block].start, e1[segment.block].end)
    if (!serialize || segment.o === undefined || segment.e0 === undefined) return lines(text)
    const block = plan.e0Blocks[segment.e0]
    const merged = mergeLines(original.slice(o[segment.o].start, o[segment.o].end), plan.e0.slice(block.start, block.end), text, eol)
    // The merged block must read exactly like the editor's; if not, the editor's own is safer.
    return merged !== lines(text) && norm(serialize(merged)) === norm(serialize(text)) ? merged : lines(text)
  }
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
    out += segment.from === 'o' ? original.slice(o[segment.first].start, o[segment.last].end) : written(segment)
  })
  const last = segments.at(-1)
  if (!last) return ''
  // The file's own ending (blank lines, or none at all), also after a changed or a new last block.
  const ending = o.length ? original.slice(o[o.length - 1].end) : ''
  if (last.from === 'o' && last.last === o.length - 1) out += ending
  else out += o.length && /^\s*$/.test(ending) ? ending : eol
  return out
}
