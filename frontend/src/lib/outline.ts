/**
 * The headings of a note, from its Markdown: for the quick switcher's `#` and the outline beside the note. ATX
 * headings (`# Title`) and setext ones (a line of `=` or `-` under text), not inside fenced code, comments, math or
 * the front matter; the closing hashes of `## Title ##` go.
 */

export type Heading = { level: number; text: string; line: number }

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const ATX_START = /^ {0,3}(#{1,6})(?:[ \t]+([^\n]*))?$/

/**
 * An ATX heading line as `[line, hashes, words]`, the closing hashes of `## Title ##` taken off; null for any other
 * line. The rest of the line is taken whole and trimmed by hand: a pattern with a lazy middle and an optional closing
 * tried every blank as the end, and a long line of them held the page (review before 1.0.0).
 */
export function atx(line: string): [string, string, string] | null {
  const found = ATX_START.exec(line)
  if (!found) return null
  let words = (found[2] ?? '').trimEnd()
  let end = words.length
  while (end > 0 && words[end - 1] === '#') end -= 1
  if (end < words.length && (end === 0 || words[end - 1] === ' ' || words[end - 1] === '\t')) words = words.slice(0, end).trimEnd()
  return [line, found[1], words.trim()]
}
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/

/** How much of a heading is shown and cleaned. */
const MAX_HEADING = 1000

/** Inline marks as the reader sees them: `**Plan**` is "Plan", `[[Note|Alias]]` is "Alias". */
export function headingText(raw: string): string {
  // What the outline and the switcher show is a line; cut before cleaning, whose patterns grow with the square of a
  // long heading full of marks (review before 1.0.0).
  return raw
    .slice(0, MAX_HEADING)
    .replace(/!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_, target: string, alias?: string) => alias ?? target)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|==|~~|`/g, '')
    .replace(/(^|\W)[*_](\S(?:.*?\S)?)[*_](?=\W|$)/g, '$1$2')
    .trim()
}

export function headingsOf(markdown: string): Heading[] {
  const lines = markdown.split(/\r?\n/)
  const out: Heading[] = []
  let start = 0
  // Front matter: only at the very top, closed by --- or ...
  if (lines[0] === '---') {
    const end = lines.findIndex((line, index) => index > 0 && (line === '---' || line === '...'))
    if (end > 0) start = end + 1
  }
  let fence: string | null = null
  let comment = false
  let math = false
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    const opened = FENCE.exec(line)
    if (fence) {
      if (opened && opened[1][0] === fence[0] && opened[1].length >= fence.length && line.trim() === opened[1]) fence = null
      continue
    }
    if (opened) {
      fence = opened[1]
      continue
    }
    // %% … %% and $$ … $$ over several lines hide what is between them.
    const marks = (line.match(/%%/g) ?? []).length
    if (comment || (marks % 2 === 1 && line.trim().startsWith('%%'))) {
      if (marks % 2 === 1) comment = !comment
      continue
    }
    if (line.trim() === '$$') {
      math = !math
      continue
    }
    if (math) continue
    const found = atx(line)
    if (found) {
      const text = headingText(found[2])
      if (text) out.push({ level: found[1].length, text, line: i + 1 })
      continue
    }
    const under = SETEXT.exec(line)
    const above = lines[i - 1]
    if (under && i > start && above !== undefined && above.trim() && !atx(above) && !/^ {0,3}([-*+]|\d+[.)])\s/.test(above) && !/^\s*>/.test(above)) {
      // "---" under a paragraph is a heading; on its own (after an empty line) it is a rule, handled above.
      const text = headingText(above)
      const last = out[out.length - 1]
      if (text && !(last && last.line === i)) out.push({ level: under[1][0] === '=' ? 1 : 2, text, line: i })
    }
  }
  return out
}
