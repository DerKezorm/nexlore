/**
 * Typing laid onto a text from outside. The app merges what it was told last (`base`) and hands the result back
 * (`remote`); what was typed since (`local`) is one stretch, at most 300 ms of it. It goes into the remote text where
 * it stood, unless the remote text changed that very place: then null, and the remote text is taken as it is.
 */

/** The lines of a text, each with its line break. */
function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/** Beyond this many line pairs the changed middle counts as one change (still right, only more often in the way). */
const MAX_PAIRS = 1_000_000

/** Where `remote` differs from `base`, by whole lines: [from, to) in base and how much longer remote is there. */
export function changes(base: string, remote: string): { from: number; to: number; grow: number }[] {
  const a = lines(base)
  const b = lines(remote)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const n = endA - start
  const m = endB - start
  // Pairs of equal lines in the middle, by the longest common run of lines; one change when it is too big to count.
  const same: [number, number][] = []
  if (n && m && n * m <= MAX_PAIRS) {
    const longest = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        longest[i][j] = a[start + i] === b[start + j] ? longest[i + 1][j + 1] + 1 : Math.max(longest[i + 1][j], longest[i][j + 1])
      }
    }
    for (let i = 0, j = 0; i < n && j < m; ) {
      if (a[start + i] === b[start + j]) same.push([start + i++, start + j++])
      else if (longest[i + 1][j] >= longest[i][j + 1]) i++
      else j++
    }
  }
  same.push([endA, endB])
  const offsets = (list: string[]) => list.reduce<number[]>((at, line) => (at.push(at[at.length - 1] + line.length), at), [0])
  const atA = offsets(a)
  const atB = offsets(b)
  const out: { from: number; to: number; grow: number }[] = []
  let i = start
  let j = start
  for (const [nextA, nextB] of same) {
    if (nextA > i || nextB > j) out.push({ from: atA[i], to: atA[nextA], grow: atB[nextB] - atB[j] - (atA[nextA] - atA[i]) })
    i = nextA + 1
    j = nextB + 1
  }
  return out
}

export function rebase(base: string, local: string, remote: string): string | null {
  if (local === base || remote === local) return remote
  if (remote === base) return local
  // The typed stretch: base[from, to) became `typed`.
  let from = 0
  while (from < base.length && from < local.length && base[from] === local[from]) from++
  let back = 0
  while (back < base.length - from && back < local.length - from && base[base.length - 1 - back] === local[local.length - 1 - back]) back++
  const to = base.length - back
  const typed = local.slice(from, local.length - back)
  let shift = 0
  for (const change of changes(base, remote)) {
    // Lines put in where the typing starts come before it.
    if (change.to <= from) shift += change.grow
    else if (change.from >= to) break
    else return null
  }
  return remote.slice(0, from + shift) + typed + remote.slice(to + shift)
}
