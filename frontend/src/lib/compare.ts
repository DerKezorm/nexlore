/**
 * Comparing a note with its conflict copy, block by block, and putting a note together from both.
 *
 * Blocks are cut at blank lines (not inside fenced code or the front matter), each with the blank lines after it,
 * so the pieces of a text put together again give exactly that text. Rows pair the blocks of both sides by the
 * longest common subsequence; what differs between two equal rows is one change, taken from one side, the other, or
 * both.
 */

export type Row =
  | { kind: 'same'; left: string; right: string }
  | { kind: 'change'; left: string[]; right: string[] }

export type Choice = 'left' | 'right' | 'both'

/** Blocks with their trailing blank lines; joined they are the text again, byte for byte. */
export function splitBlocks(text: string): string[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const blocks: string[] = []
  let current = ''
  let fence: string | null = null
  let head = /^---[ \t]*\r?\n/.test(text)
  lines.forEach((line, index) => {
    const bare = line.replace(/\r?\n$/, '')
    const blank = !bare.trim()
    if (head) {
      current += line
      if (index > 0 && /^(---|\.\.\.)[ \t]*$/.test(bare)) {
        // The front matter is a block of its own, even without a blank line after it.
        head = false
        blocks.push(current)
        current = ''
      }
      return
    }
    if (fence) {
      current += line
      if (bare.trimStart().startsWith(fence)) fence = null
      return
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(bare)
    if (blank) {
      current += line
      return
    }
    // A non-blank line after blank lines starts a new block.
    if (current && /\n[ \t]*\r?\n$|^[ \t]*\r?\n$/.test(current)) {
      blocks.push(current)
      current = ''
    }
    current += line
    if (opening) fence = opening[1]
  })
  if (current) blocks.push(current)
  return blocks
}

const key = (block: string) => block.replace(/\r\n?/g, '\n').trim()

export function compareTexts(left: string, right: string): Row[] {
  const a = splitBlocks(left)
  const b = splitBlocks(right)
  const ka = a.map(key)
  const kb = b.map(key)
  const n = a.length
  const m = b.length
  const table = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) table[i][j] = ka[i] === kb[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
  const rows: Row[] = []
  let change: { left: string[]; right: string[] } | null = null
  const flush = () => {
    if (change) rows.push({ kind: 'change', ...change })
    change = null
  }
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && ka[i] === kb[j]) {
      flush()
      rows.push({ kind: 'same', left: a[i], right: b[j] })
      i++
      j++
    } else if (j >= m || (i < n && table[i + 1][j] >= table[i][j + 1])) {
      change ??= { left: [], right: [] }
      change.left.push(a[i++])
    } else {
      change ??= { left: [], right: [] }
      change.right.push(b[j++])
    }
  }
  flush()
  return rows
}

/** The note put together: equal blocks from the note, each change from the chosen side. */
export function merge(rows: Row[], choices: Choice[], eol = '\n'): string {
  const pieces: string[] = []
  let change = 0
  for (const row of rows) {
    if (row.kind === 'same') pieces.push(row.left)
    else {
      const choice = choices[change++] ?? 'left'
      if (choice !== 'right') pieces.push(...row.left)
      if (choice !== 'left') pieces.push(...row.right)
    }
  }
  // Blocks that come from different places need a blank line between them.
  return pieces
    .map((piece, index) => (index < pieces.length - 1 && !/\n[ \t]*\r?\n$/.test(piece) ? piece.replace(/\r?\n?$/, eol + eol) : piece))
    .join('')
}

export type Part = { text: string; changed: boolean }

/** Words that differ between two versions of a block, for marking them. Long blocks are marked as a whole. */
export function wordDiff(left: string, right: string): { left: Part[]; right: Part[] } {
  const split = (text: string) => text.match(/\s+|[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? []
  const a = split(left)
  const b = split(right)
  if (a.length * b.length > 400_000) return { left: [{ text: left, changed: true }], right: [{ text: right, changed: true }] }
  const table = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
  const outA: Part[] = []
  const outB: Part[] = []
  const push = (out: Part[], text: string, changed: boolean) => {
    const last = out.at(-1)
    if (last && last.changed === changed) last.text += text
    else out.push({ text, changed })
  }
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push(outA, a[i++], false)
      push(outB, b[j++], false)
    } else if (j >= b.length || (i < a.length && table[i + 1][j] >= table[i][j + 1])) push(outA, a[i++], true)
    else push(outB, b[j++], true)
  }
  return { left: outA, right: outB }
}

const COPY = /^(.*) \(conflict \d{4}-\d{2}-\d{2} \d{6}\)\.md$/

/** The note a conflict copy belongs to, or null. */
export function originalOf(path: string): string | null {
  const match = COPY.exec(path)
  return match ? `${match[1]}.md` : null
}

/** Conflict copies of a note among the given paths, newest first. */
export function copiesOf(path: string, paths: Iterable<string>): string[] {
  const out: string[] = []
  for (const candidate of paths) if (originalOf(candidate) === path) out.push(candidate)
  return out.sort().reverse()
}
