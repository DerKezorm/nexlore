/**
 * The task lines of a note in the order the reading view shows their boxes (review before 1.0.0, P5.2): what a click
 * on the n-th box ticks off. A box is a list item starting `[ ]` or `[x]` with a space and words after it, as the
 * reading view's Markdown sees it; in a quote too; not in the front matter, not in a code block.
 */
export type TaskLine = { line: number; raw: string; done: boolean }

const TASK = /^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\] +\S/
const FENCE = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})/

export function taskLines(content: string): TaskLine[] {
  const lines = content.split(/\r?\n/)
  const out: TaskLine[] = []
  let index = 0
  if (/^---[ \t]*$/.test(lines[0] ?? '')) {
    const end = lines.findIndex((line, at) => at > 0 && /^(---|\.\.\.)[ \t]*$/.test(line))
    if (end > 0) index = end + 1
  }
  let fence: string | null = null
  for (; index < lines.length; index++) {
    const line = lines[index]
    const opening = FENCE.exec(line)
    if (fence) {
      if (opening && opening[1][0] === fence[0] && opening[1].length >= fence.length) fence = null
      continue
    }
    if (opening) {
      fence = opening[1]
      continue
    }
    const task = TASK.exec(line)
    if (task) out.push({ line: index + 1, raw: line, done: task[1] !== ' ' })
  }
  return out
}
