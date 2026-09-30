/**
 * Two amounts of money in one sentence (`5 $ und 10 $`) are words, not a formula (review before 1.0.0, P3.12). remark-math
 * takes everything between two dollar signs as a formula; the reading view, as Obsidian, only when the formula does
 * not begin or end with a blank. The editor now reads it the same way: such a "formula" goes back to plain text, and
 * the writer keeps it as typed (`syntax.ts` protects it from escaping).
 */
import { $remark } from '@milkdown/kit/utils'

type Node = { type: string; value?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } }

/** An inline formula as written (`$ und 10 $`) that is really text: a blank right inside a dollar sign. */
export const spacedFormula = (written: string) => /^\$(?:\s|[^$]*\s\$$)/.test(written)

function walk(node: Node, source: string): void {
  if (!node.children) return
  node.children = node.children.map((child) => {
    const start = child.position?.start.offset
    const end = child.position?.end.offset
    if (child.type !== 'inlineMath' || start === undefined || end === undefined) return child
    const written = source.slice(start, end)
    // remark-math trims the blanks off the value; the source still has them.
    return spacedFormula(written) ? { type: 'text', value: written, position: child.position } : child
  })
  for (const child of node.children) walk(child, source)
}

export const dollarText = $remark('nxDollarText', () => () => (tree: unknown, file: unknown) =>
  walk(tree as Node, String((file as { value?: unknown } | undefined)?.value ?? '')))
