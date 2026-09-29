/**
 * The headings of a note, from its Markdown: for the quick switcher's `#` and the outline beside the note. ATX
 * headings (`# Title`) and setext ones (a line of `=` or `-` under text), not inside fenced code, comments, math or
 * the front matter; the closing hashes of `## Title ##` go.
 */

export type Heading = { level: number; text: string; line: number }

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/

/** Inline marks as the reader sees them: `**Plan**` is "Plan", `[[Note|Alias]]` is "Alias". */
export function headingText(raw: string): string {
  return raw
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
    const atx = ATX.exec(line)
    if (atx) {
      const text = headingText(atx[2] ?? '')
      if (text) out.push({ level: atx[1].length, text, line: i + 1 })
      continue
    }
    const under = SETEXT.exec(line)
    const above = lines[i - 1]
    if (under && i > start && above !== undefined && above.trim() && !ATX.exec(above) && !/^ {0,3}([-*+]|\d+[.)])\s/.test(above) && !/^\s*>/.test(above)) {
      // "---" under a paragraph is a heading; on its own (after an empty line) it is a rule, handled above.
      const text = headingText(above)
      const last = out[out.length - 1]
      if (text && !(last && last.line === i)) out.push({ level: under[1][0] === '=' ? 1 : 2, text, line: i })
    }
  }
  return out
}
