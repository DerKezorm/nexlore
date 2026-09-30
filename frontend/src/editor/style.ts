/**
 * The author's Markdown style, read from the file, so a block written anew looks like its neighbours: `-` or `*`
 * for lists, `~~~` or backticks for code, underlined headings, indented code, bare web addresses.
 *
 * Only a guess from what is there; with nothing to go by, Obsidian's own defaults.
 */
import type { Options } from 'mdast-util-to-markdown'

export type Style = Pick<Options, 'bullet' | 'bulletOther' | 'emphasis' | 'strong' | 'fence' | 'fences' | 'rule' | 'setext'> & {
  /** New web addresses without angle brackets, as GFM finds them by itself. */
  bareUrls: boolean
  /** What indents the inside of a list item (nested lists): a tab, four spaces, or null for the marker's width. */
  listIndent: string | null
  /** Tables padded so the pipes line up (Obsidian's Advanced Tables does that), or written compactly. */
  alignTables: boolean
  /** A hard line break as two blanks at the end of the line (as most files have it) or as a backslash. */
  breakWithBlanks: boolean
}

/** Counts outside fenced code, which is not Markdown. */
function outsideCode(text: string): string {
  return text.replace(/^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1\2[`~]*[ \t]*$|$(?![\s\S]))/gm, '')
}

function most<T extends string>(counts: Record<T, number>, fallback: T): T {
  let best = fallback
  let top = 0
  for (const [key, count] of Object.entries(counts) as [T, number][]) {
    if (count > top) {
      best = key
      top = count
    }
  }
  return best
}

export function detectStyle(original: string): Style {
  const text = original.replace(/\r\n?/g, '\n')
  const prose = outsideCode(text)

  const bullets = { '-': 0, '*': 0, '+': 0 }
  for (const match of prose.matchAll(/^[ \t]*([-*+])[ \t]+(?!\1[ \t]*\1)/gm)) bullets[match[1] as '-' | '*' | '+']++
  const bullet = most(bullets, '-')

  const fences = { '`': 0, '~': 0 }
  for (const match of text.matchAll(/^ {0,3}(`{3,}|~{3,})/gm)) fences[match[1][0] as '`' | '~']++
  const fenced = fences['`'] + fences['~'] > 0
  // Indented code: four spaces after a blank line, not inside a list.
  const indented = /(?:^|\n)[ \t]*\n {4,}\S/.test(prose) && !/^[ \t]*(?:[-*+]|\d+[.)])[ \t]/m.test(prose)

  const rules = { '-': 0, '*': 0, _: 0 }
  for (const match of prose.matchAll(/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm)) rules[match[1] as '-' | '*' | '_']++

  const emphasis = { '*': 0, _: 0 }
  for (const match of prose.matchAll(/(?<![*_\w])([*_])(?!\1)[^\s*_](?:[^\n]*?[^\s*_])?\1(?![*_\w])/g)) emphasis[match[1] as '*' | '_']++
  const strong = { '*': 0, _: 0 }
  for (const match of prose.matchAll(/(\*\*|__)[^\s*_][^\n]*?\1/g)) strong[match[0][0] as '*' | '_']++

  const setext = /^[^\n#>\-*+|].*\n(?:=+|-+)[ \t]*$/m.test(prose) && !/^#{1,2}[ \t]/m.test(prose)
  const angled = (prose.match(/<https?:\/\/[^>\s]+>/g) ?? []).length
  const bare = (prose.match(/(?<![<(\]\w])https?:\/\/[^\s<>]+/g) ?? []).length

  // The smallest indentation of a nested list marker: a tab, or at least four spaces.
  let listIndent: string | null = null
  for (const match of prose.matchAll(/^([ \t]+)(?:[-*+]|\d+[.)])[ \t]/gm)) {
    const lead = match[1]
    if (lead.startsWith('\t')) {
      listIndent = '\t'
      break
    }
    if (lead.length >= 4 && (listIndent === null || lead.length < listIndent.length)) listIndent = ' '.repeat(Math.min(lead.length, 4))
    if (lead.length < 4) {
      listIndent = null
      break
    }
  }

  // A table row with a cell padded by more than one blank.
  const alignTables = /^ {0,3}\|.*\S {2,}\|/m.test(prose)

  // Hard breaks: two blanks or a backslash at a line's end, with text on the next line.
  const blanks = (prose.match(/\S {2,}\n(?=[^\n])/g) ?? []).length
  const slashes = (prose.match(/\S\\\n(?=[^\n])/g) ?? []).length

  return {
    alignTables,
    breakWithBlanks: blanks >= slashes,
    bullet,
    bulletOther: bullet === '-' ? '*' : '-',
    emphasis: most(emphasis, '*'),
    strong: most(strong, '*'),
    fence: most(fences, '`'),
    fences: fenced || !indented,
    rule: most(rules, '-'),
    setext,
    bareUrls: bare >= angled,
    listIndent,
  }
}
