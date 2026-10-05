/**
 * The toolbar in the Markdown view (design answer 05.10.2026: "Volle Leiste"): the same commands as in the visual
 * editor, done on the text itself. Each command reads the text and the selection and says what to put where; the
 * caller writes it into the field so that the browser's own undo takes it back.
 *
 * Marks wrap the selection (or take it off when it is wrapped already); blocks work on every line the selection
 * touches. What has no meaning in plain text (table rows, sorting) is not offered here: the table button inserts one.
 */
import type { EditorCommand, EditorStatus } from '../editor/editor'

/** One change: the text from `from` to `to` becomes `insert`, then the selection is `select`. */
export type SourceEdit = { from: number; to: number; insert: string; select: [number, number] }

const MARKS: Partial<Record<EditorCommand, string>> = { bold: '**', italic: '*', strike: '~~', highlight: '==', code: '`' }
const HEADINGS: Partial<Record<EditorCommand, string>> = { text: '', h1: '# ', h2: '## ', h3: '### ' }
const HEADING = /^#{1,6} /
const BULLET = /^(\s*)[-*+] (?!\[[ xX/-]\] )/
const TASK = /^(\s*)[-*+] \[[ xX/-]\] /
const ORDERED = /^(\s*)\d+[.)] /
const QUOTE = /^> ?/

/** The lines the selection touches: where they start and end in the text. */
function linesOf(text: string, from: number, to: number): { start: number; end: number; lines: string[] } {
  const start = text.lastIndexOf('\n', from - 1) + 1
  const stop = text.indexOf('\n', to > from && text[to - 1] === '\n' ? to - 1 : to)
  const end = stop === -1 ? text.length : stop
  return { start, end, lines: text.slice(start, end).split('\n') }
}

/** Every touched line rewritten; the selection then covers them all (or stays a caret at the end of one line). */
function eachLine(text: string, from: number, to: number, change: (line: string, index: number) => string): SourceEdit {
  const { start, end, lines } = linesOf(text, from, to)
  const insert = lines.map(change).join('\n')
  const caret = from === to && lines.length === 1
  return { from: start, to: end, insert, select: caret ? [start + insert.length, start + insert.length] : [start, start + insert.length] }
}

/** Without a list mark of any kind (the indent stays). */
function bare(line: string): string {
  return line.replace(TASK, '$1').replace(BULLET, '$1').replace(ORDERED, '$1')
}

function list(text: string, from: number, to: number, kind: 'bullet' | 'ordered' | 'task'): SourceEdit {
  const { lines } = linesOf(text, from, to)
  const test = kind === 'task' ? TASK : kind === 'ordered' ? ORDERED : BULLET
  const all = lines.filter((line) => line.trim()).every((line) => test.test(line))
  let number = 0
  return eachLine(text, from, to, (line) => {
    if (!line.trim() && lines.length > 1) return line
    const indent = /^\s*/.exec(line)![0]
    const rest = bare(line).slice(indent.length)
    if (all) return indent + rest
    number += 1
    return indent + (kind === 'task' ? '- [ ] ' : kind === 'ordered' ? `${number}. ` : '- ') + rest
  })
}

function wrap(text: string, from: number, to: number, mark: string): SourceEdit {
  const n = mark.length
  // Wrapped already, inside or around the selection: the marks go.
  if (to - from >= 2 * n && text.startsWith(mark, from) && text.slice(to - n, to) === mark)
    return { from, to, insert: text.slice(from + n, to - n), select: [from, to - 2 * n] }
  if (from >= n && text.slice(from - n, from) === mark && text.slice(to, to + n) === mark)
    return { from: from - n, to: to + n, insert: text.slice(from, to), select: [from - n, to - n] }
  return { from, to, insert: mark + text.slice(from, to) + mark, select: [from + n, to + n] }
}

/** A block of its own (code, a formula, a divider, a table): on lines of its own, with a blank line before and after. */
function block(text: string, from: number, to: number, open: string, close: string, inner: string): SourceEdit {
  const { start, end } = from === to ? { start: from, end: to } : linesOf(text, from, to)
  const before = start > 0 && text[start - 1] !== '\n' ? '\n\n' : start > 1 && text[start - 2] !== '\n' ? '\n' : ''
  const after = end < text.length && text[end] !== '\n' ? '\n\n' : end < text.length - 1 && text[end + 1] !== '\n' ? '\n' : ''
  const body = from === to ? inner : text.slice(start, end)
  const head = before + open
  const insert = head + body + close + after
  return { from: start, to: end, insert, select: [start + head.length, start + head.length + body.length] }
}

/** What a command does to the text; null where it does nothing in the Markdown view. */
export function sourceEdit(command: EditorCommand, text: string, from: number, to: number, option?: string): SourceEdit | null {
  const mark = MARKS[command]
  if (mark) return wrap(text, from, to, mark)
  const heading = HEADINGS[command]
  if (heading !== undefined) return eachLine(text, from, to, (line) => heading + line.replace(HEADING, ''))
  const chosen = text.slice(from, to)
  switch (command) {
    case 'clear': {
      // The marks of bold, italic, strike, highlight and code; a star between words or in a list mark stays.
      const plain = chosen.replace(/\*\*|~~|==|`|(?<![\w*])\*(?=\S)|(?<=\S)\*(?![\w*])/g, '')
      return { from, to, insert: plain, select: [from, from + plain.length] }
    }
    case 'wikiLink':
      return { from, to, insert: `[[${chosen}]]`, select: [from + 2, from + 2 + chosen.length] }
    case 'embed':
      return { from, to, insert: `![[${chosen}]]`, select: [from + 3, from + 3 + chosen.length] }
    case 'link': {
      const insert = `[${chosen}](https://)`
      // The caret where the address goes; with nothing chosen, between the brackets for the words.
      const at = chosen ? from + chosen.length + 3 + 'https://'.length : from + 1
      return { from, to, insert, select: [at, at] }
    }
    case 'bulletList':
      return list(text, from, to, 'bullet')
    case 'orderedList':
      return list(text, from, to, 'ordered')
    case 'taskList':
      return list(text, from, to, 'task')
    case 'quote': {
      const { lines } = linesOf(text, from, to)
      const all = lines.every((line) => QUOTE.test(line))
      return eachLine(text, from, to, (line) => (all ? line.replace(QUOTE, '') : '> ' + line))
    }
    case 'callout': {
      const kind = option || 'note'
      const edit = eachLine(text, from, to, (line) => '> ' + line.replace(QUOTE, ''))
      const head = `> [!${kind}]\n`
      return { from: edit.from, to: edit.to, insert: head + edit.insert, select: [edit.from + head.length + 2, edit.from + head.length + edit.insert.length] }
    }
    case 'indent':
      return eachLine(text, from, to, (line) => '\t' + line)
    case 'outdent':
      return eachLine(text, from, to, (line) => line.replace(/^(\t| {1,4})/, ''))
    case 'codeBlock':
      return block(text, from, to, '```\n', '\n```', '')
    case 'math':
      return block(text, from, to, '$$\n', '\n$$', '')
    case 'divider': {
      // Nothing to write into a divider: the caret goes after it.
      const edit = block(text, to, to, '', '---', '')
      const end = edit.from + edit.insert.trimEnd().length
      return { ...edit, select: [end, end] }
    }
    case 'table': {
      // The first heading chosen, to be typed over.
      const edit = block(text, to, to, '', '', '| Column | Column |\n| --- | --- |\n|  |  |')
      const at = edit.from + edit.insert.indexOf('Column')
      return { ...edit, select: [at, at + 'Column'.length] }
    }
    case 'selectAll':
      return { from: 0, to: 0, insert: '', select: [0, text.length] }
    default:
      return null
  }
}

/** What holds where the caret is, read from the line and the marks around the selection. */
export function sourceStatus(text: string, from: number, to: number): EditorStatus {
  const { lines } = linesOf(text, from, to)
  const line = lines[0] ?? ''
  const fences = (text.slice(0, from).match(/^(```|~~~)/gm) ?? []).length
  const formulas = (text.slice(0, from).match(/^\$\$\s*$/gm) ?? []).length
  const heading = /^(#{1,3}) /.exec(line)?.[1].length
  const around = (mark: string) =>
    (from >= mark.length && text.slice(from - mark.length, from) === mark && text.slice(to, to + mark.length) === mark) ||
    (to - from >= 2 * mark.length && text.startsWith(mark, from) && text.slice(to - mark.length, to) === mark)
  const marks = [
    ...(around('**') ? ['strong'] : []),
    ...(around('*') && !around('**') ? ['emphasis'] : []),
    ...(around('~~') ? ['strike_through'] : []),
    ...(around('`') ? ['inlineCode'] : []),
  ]
  return {
    marks,
    block: fences % 2 ? 'code' : formulas % 2 ? 'math' : heading === 1 ? 'h1' : heading === 2 ? 'h2' : heading === 3 ? 'h3' : 'text',
    list: TASK.test(line) ? 'task' : ORDERED.test(line) ? 'ordered' : BULLET.test(line) ? 'bullet' : null,
    quote: QUOTE.test(line),
    // Rows and columns are not offered in the Markdown view: the table button only inserts one.
    table: false,
    headerRow: false,
    canUndo: true,
    canRedo: true,
    canIndent: true,
    canOutdent: /^(\t| )/.test(line),
  }
}
