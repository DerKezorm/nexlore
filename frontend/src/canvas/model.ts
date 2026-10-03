/**
 * A canvas as the page holds it: the JSON Canvas file (jsoncanvas.org, 1.0) taken apart into its cards (`nodes`) and
 * lines (`edges`), and put together again the way Obsidian writes it. What nexlore does not know stays: another
 * program's fields on a card, a fifth kind of card, more keys at the top. Every change gives a new canvas (the old one
 * stays as it was, so going back is keeping the old one).
 *
 * **How Obsidian writes a canvas** (measured on 13 files, 12 came out byte for byte): `{`, every key of the top on a
 * line of its own after one tab; a list that is not empty as `"nodes":[`, each card on its own line after two tabs as
 * `JSON.stringify` writes it, a comma after every card but the last, then a tab and `]`; an empty list `"edges":[]` on
 * one line; no line break at the end. A card keeps the order of its fields; a new field goes to the end. The server
 * writes the same (`services/canvas.py`).
 */

export type Side = 'top' | 'right' | 'bottom' | 'left'
export type End = 'none' | 'arrow'

export type CanvasNode = {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  color?: string
  /** A text card's Markdown. */
  text?: string
  /** A file card's path from the top of the space, and optionally a heading or block in it (`#Part`). */
  file?: string
  subpath?: string
  /** A link card's address. */
  url?: string
  /** A group's name, background picture and how it fills the group. */
  label?: string
  background?: string
  backgroundStyle?: string
  [key: string]: unknown
}

export type CanvasEdge = {
  id: string
  fromNode: string
  fromSide?: Side
  fromEnd?: End
  toNode: string
  toSide?: Side
  toEnd?: End
  color?: string
  label?: string
  [key: string]: unknown
}

export type Canvas = {
  /** Every key of the top in its order, `nodes` and `edges` included (their values are the lists below). */
  readonly top: readonly string[]
  readonly extra: Readonly<Record<string, unknown>>
  readonly nodes: readonly CanvasNode[]
  readonly edges: readonly CanvasEdge[]
}

export const SIDES: Side[] = ['top', 'right', 'bottom', 'left']
/** The six colours the format names; how they look is each program's own (`canvas.css`). */
export const PRESET_COLORS = ['1', '2', '3', '4', '5', '6'] as const

export class CanvasError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The canvas in `text`; `CanvasError` when it is none nexlore can keep (the page then only shows it). */
export function parseCanvas(text: string): Canvas {
  let data: unknown
  try {
    data = text.trim() ? JSON.parse(text.replace(/^\ufeff/, '')) : {}
  } catch {
    throw new CanvasError('not JSON')
  }
  if (!isObject(data)) throw new CanvasError('not an object')
  const lists: Record<'nodes' | 'edges', Record<string, unknown>[]> = { nodes: [], edges: [] }
  for (const key of ['nodes', 'edges'] as const) {
    const items = data[key] ?? []
    if (!Array.isArray(items)) throw new CanvasError(`${key} is not a list`)
    for (const item of items) if (!isObject(item) || typeof item.id !== 'string' || !item.id) throw new CanvasError('an element without id')
    lists[key] = items as Record<string, unknown>[]
  }
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) if (key !== 'nodes' && key !== 'edges') extra[key] = value
  // A canvas without the lists gets them when it is written (Obsidian writes both always).
  const top = Object.keys(data)
  for (const key of ['nodes', 'edges']) if (!top.includes(key)) top.push(key)
  return { top, extra, nodes: lists.nodes as CanvasNode[], edges: lists.edges as CanvasEdge[] }
}

/** The canvas written the way Obsidian writes one. */
export function serializeCanvas(canvas: Canvas): string {
  const lines = ['{']
  canvas.top.forEach((key, position) => {
    const comma = position < canvas.top.length - 1 ? ',' : ''
    const value = key === 'nodes' ? canvas.nodes : key === 'edges' ? canvas.edges : canvas.extra[key]
    if (Array.isArray(value) && value.length) {
      lines.push(`\t${JSON.stringify(key)}:[`)
      value.forEach((item, index) => lines.push(`\t\t${JSON.stringify(item)}${index < value.length - 1 ? ',' : ''}`))
      lines.push(`\t]${comma}`)
    } else {
      lines.push(`\t${JSON.stringify(key)}:${JSON.stringify(value)}${comma}`)
    }
  })
  lines.push('}')
  return lines.join('\n')
}

export const EMPTY_CANVAS: Canvas = { top: ['nodes', 'edges'], extra: {}, nodes: [], edges: [] }

/** An id as Obsidian makes them: 16 hexadecimal digits, not one the canvas has already. */
export function newId(canvas?: Canvas): string {
  const taken = new Set([...(canvas?.nodes ?? []), ...(canvas?.edges ?? [])].map((item) => item.id))
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(8))
    const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    if (!taken.has(id)) return id
  }
}

type NewNode =
  | { type: 'text'; text: string }
  | { type: 'file'; file: string; subpath?: string }
  | { type: 'link'; url: string }
  | { type: 'group'; label?: string }

/** A new card, its fields in the order Obsidian writes a new one (id, type, what it shows, place, size, colour). */
export function makeNode(canvas: Canvas, what: NewNode, box: { x: number; y: number; width: number; height: number }): CanvasNode {
  const { type, ...shows } = what
  // A group writes its name after its place and size, every other card what it shows before them (as Obsidian).
  const node: CanvasNode = { id: newId(canvas), type, ...(type === 'group' ? {} : shows) } as CanvasNode
  if (node.subpath === undefined) delete node.subpath
  node.x = Math.round(box.x)
  node.y = Math.round(box.y)
  node.width = Math.round(box.width)
  node.height = Math.round(box.height)
  if (type === 'group' && 'label' in shows && shows.label !== undefined) node.label = shows.label
  return node
}

/** Cards go in on top of the others; a group goes in below all of them (it holds cards, it does not cover them). */
export function addNode(canvas: Canvas, node: CanvasNode): Canvas {
  return { ...canvas, nodes: node.type === 'group' ? [node, ...canvas.nodes] : [...canvas.nodes, node] }
}

/**
 * Change cards: each changed field keeps its place in the card, a new one goes to the end, `undefined` takes a field
 * away. Positions and sizes are whole pixels, as the format says.
 */
export function updateNodes(canvas: Canvas, changes: Record<string, Partial<CanvasNode>>): Canvas {
  let changed = false
  const nodes = canvas.nodes.map((node) => {
    const change = changes[node.id]
    if (!change) return node
    const next: CanvasNode = { ...node }
    for (const [key, value] of Object.entries(change)) {
      if (value === undefined) delete next[key]
      else next[key] = ['x', 'y', 'width', 'height'].includes(key) ? Math.round(value as number) : value
    }
    if (JSON.stringify(next) === JSON.stringify(node)) return node
    changed = true
    return next
  })
  return changed ? { ...canvas, nodes } : canvas
}

/** Cards away, and every line that touched one of them. */
export function removeNodes(canvas: Canvas, ids: Iterable<string>): Canvas {
  const gone = new Set(ids)
  if (!canvas.nodes.some((node) => gone.has(node.id))) return canvas
  return {
    ...canvas,
    nodes: canvas.nodes.filter((node) => !gone.has(node.id)),
    edges: canvas.edges.filter((edge) => !gone.has(edge.fromNode) && !gone.has(edge.toNode)),
  }
}

/** A line between two cards, from a side to a side; ends as the format writes them only where they differ from its
 * defaults (none at the start, an arrow at the end). */
export function makeEdge(canvas: Canvas, from: { node: string; side?: Side }, to: { node: string; side?: Side }): CanvasEdge {
  return {
    id: newId(canvas),
    fromNode: from.node,
    ...(from.side ? { fromSide: from.side } : {}),
    toNode: to.node,
    ...(to.side ? { toSide: to.side } : {}),
  }
}

export function addEdge(canvas: Canvas, edge: CanvasEdge): Canvas {
  return { ...canvas, edges: [...canvas.edges, edge] }
}

export function updateEdge(canvas: Canvas, id: string, change: Partial<CanvasEdge>): Canvas {
  let changed = false
  const edges = canvas.edges.map((edge) => {
    if (edge.id !== id) return edge
    const next: CanvasEdge = { ...edge }
    for (const [key, value] of Object.entries(change)) {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    changed = JSON.stringify(next) !== JSON.stringify(edge)
    return changed ? next : edge
  })
  return changed ? { ...canvas, edges } : canvas
}

export function removeEdges(canvas: Canvas, ids: Iterable<string>): Canvas {
  const gone = new Set(ids)
  if (!canvas.edges.some((edge) => gone.has(edge.id))) return canvas
  return { ...canvas, edges: canvas.edges.filter((edge) => !gone.has(edge.id)) }
}

type Box = { x: number; y: number; width: number; height: number }

/** The cards a group holds: those lying wholly inside it (in JSON Canvas a group holds what lies in it, nothing else). */
export function inGroup(canvas: Canvas, group: Box & { id: string }): CanvasNode[] {
  return canvas.nodes.filter(
    (node) =>
      node.id !== group.id &&
      node.x >= group.x &&
      node.y >= group.y &&
      node.x + node.width <= group.x + group.width &&
      node.y + node.height <= group.y + group.height,
  )
}

/** Where a line leaves and meets two cards that do not say: the sides that face each other. */
export function facingSides(from: Box, to: Box): [Side, Side] {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2)
  const dy = to.y + to.height / 2 - (from.y + from.height / 2)
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ['right', 'left'] : ['left', 'right']
  return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom']
}

/** The side of a box nearest a point (in the same coordinates): where a line let go on a card ends. */
export function nearestSide(box: { left: number; top: number; right: number; bottom: number }, x: number, y: number): Side {
  const distances: [Side, number][] = [
    ['top', Math.abs(y - box.top)],
    ['bottom', Math.abs(box.bottom - y)],
    ['left', Math.abs(x - box.left)],
    ['right', Math.abs(box.right - x)],
  ]
  return distances.reduce((best, item) => (item[1] < best[1] ? item : best))[0]
}

/** The box around every card, or null for an empty canvas. */
export function bounds(nodes: readonly Box[]): Box | null {
  if (!nodes.length) return null
  const left = Math.min(...nodes.map((node) => node.x))
  const top = Math.min(...nodes.map((node) => node.y))
  const right = Math.max(...nodes.map((node) => node.x + node.width))
  const bottom = Math.max(...nodes.map((node) => node.y + node.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** A colour of the format as CSS: a preset becomes the canvas's own colour of that number, `#rrggbb` stays. */
export function colorOf(color: string | undefined): string | null {
  if (!color) return null
  if ((PRESET_COLORS as readonly string[]).includes(color)) return `var(--canvas-color-${color})`
  return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color) ? color : null
}

/** The title a card shows far out: what it is called, or the start of its text. */
export function titleOf(node: CanvasNode): string {
  if (node.type === 'text') {
    const plain = (node.text ?? '')
      .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
      .replace(/[*_~`=]+/g, '')
      .replace(/^[#>\-+\s[\]x]+/gm, '')
    return plain.trim().split('\n')[0].slice(0, 60)
  }
  if (node.type === 'file') return (node.file ?? '').split('/').pop()?.replace(/\.md$/i, '') ?? ''
  if (node.type === 'link') {
    try {
      return new URL(node.url ?? '').hostname
    } catch {
      return node.url ?? ''
    }
  }
  if (node.type === 'group') return node.label ?? ''
  return node.type
}
