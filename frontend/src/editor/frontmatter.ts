/**
 * The front matter of a note (`---` YAML `---` at the very top) as properties, the way Obsidian shows them.
 *
 * The editor never sees the front matter: the note is split into head and body, the body goes to the editor, the
 * head to the properties table. Writing back changes only what changed: the YAML document is edited in place
 * (comments, order, quoting and the untouched lines stay as they were), and an untouched head is copied byte for
 * byte.
 */
import { Document, isMap, isScalar, isSeq, parseDocument, type Node as YamlNode } from 'yaml'

/** `---` at the very top, up to the closing `---` or `...` on a line of its own. */
const HEAD = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/

export type Split = { head: string; body: string }

export function splitNote(text: string): Split {
  const match = HEAD.exec(text)
  return match ? { head: match[0], body: text.slice(match[0].length) } : { head: '', body: text }
}

export type PropertyKind = 'text' | 'list' | 'number' | 'checkbox' | 'date' | 'datetime' | 'other'

export type Property = {
  key: string
  kind: PropertyKind
  /** text, number, date: the text shown; list: the items; checkbox: true/false; other: the YAML itself. */
  value: string | string[] | boolean
}

export type Properties =
  | { ok: true; items: Property[] }
  /** YAML that does not parse, or is not a list of names and values: shown and edited as text. */
  | { ok: false; yaml: string }

const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?$/

/** The YAML between the fences, without them. */
export function headYaml(head: string): string {
  return head.replace(/^---[ \t]*\r?\n/, '').replace(/(?:^|\r?\n)(?:---|\.\.\.)[ \t]*(?:\r?\n)?$/, '')
}

function kindOf(key: string, node: unknown): Property {
  if (isSeq(node)) {
    const items = node.items.map((item) => (isScalar(item) ? String(item.value ?? '') : null))
    if (items.every((item) => item !== null)) return { key, kind: 'list', value: items as string[] }
  }
  if (isScalar(node) || node === null || node === undefined) {
    const value = isScalar(node) ? node.value : null
    if (typeof value === 'boolean') return { key, kind: 'checkbox', value }
    if (typeof value === 'number') return { key, kind: 'number', value: String(isScalar(node) && node.source ? node.source : value) }
    const text = value === null ? '' : String(value)
    // Tags and aliases are lists in Obsidian even when written as one word.
    if (/^(tags|aliases|cssclasses)$/i.test(key)) return { key, kind: 'list', value: text ? text.split(/[,\s]+/).filter(Boolean) : [] }
    if (DATE.test(text)) return { key, kind: 'date', value: text }
    if (DATETIME.test(text)) return { key, kind: 'datetime', value: text }
    return { key, kind: 'text', value: text }
  }
  return { key, kind: 'other', value: String(node) }
}

export function readProperties(head: string): Properties {
  const yaml = headYaml(head)
  const doc = parseDocument(yaml, { keepSourceTokens: true })
  if (doc.errors.length) return { ok: false, yaml }
  const root = doc.contents
  if (root === null) return { ok: true, items: [] }
  if (!isMap(root)) return { ok: false, yaml }
  const items: Property[] = []
  for (const pair of root.items) {
    if (!isScalar(pair.key)) return { ok: false, yaml }
    items.push(kindOf(String(pair.key.value), pair.value))
  }
  return { ok: true, items }
}

function toNode(doc: Document, property: Property): unknown {
  switch (property.kind) {
    case 'list':
      return doc.createNode(property.value as string[])
    case 'checkbox':
      return property.value === true
    case 'number': {
      const text = String(property.value).trim()
      const number = Number(text)
      return text && Number.isFinite(number) ? number : text
    }
    case 'other':
      return parseDocument(String(property.value)).contents
    default:
      return String(property.value)
  }
}

function same(a: Property | undefined, b: Property): boolean {
  return !!a && a.kind === b.kind && JSON.stringify(a.value) === JSON.stringify(b.value)
}

/**
 * The head for changed properties. Keys that did not change keep their lines exactly; a new key goes at the end, a
 * removed one goes. An empty list of properties removes the head.
 */
export function writeProperties(head: string, items: Property[]): string {
  const before = readProperties(head)
  const eol = head.includes('\r\n') ? '\r\n' : '\n'
  if (!items.length) return ''
  if (before.ok && before.items.length === items.length && before.items.every((item, i) => same(item, items[i]) && item.key === items[i].key)) return head
  const yaml = before.ok ? headYaml(head).replace(/\r\n?/g, '\n') : ''
  // The source of each property: from the line of its name to the line of the next name.
  const chunks = new Map<string, string>()
  let preamble = ''
  if (yaml) {
    const doc = parseDocument(yaml)
    const pairs = isMap(doc.contents) ? doc.contents.items : []
    const starts = pairs.map((pair) => {
      const at = (pair.key as YamlNode).range?.[0] ?? 0
      return yaml.lastIndexOf('\n', at - 1) + 1
    })
    preamble = yaml.slice(0, starts[0] ?? yaml.length)
    pairs.forEach((pair, i) => {
      const chunk = yaml.slice(starts[i], starts[i + 1] ?? yaml.length)
      chunks.set(String((pair.key as { value?: unknown }).value), chunk.endsWith('\n') ? chunk : chunk + '\n')
    })
  }
  const old = new Map(before.ok ? before.items.map((item) => [item.key, item]) : [])
  let out = preamble
  for (const item of items) {
    const kept = chunks.get(item.key)
    if (kept !== undefined && same(old.get(item.key), item)) {
      out += kept
      continue
    }
    const doc = new Document({})
    const node = toNode(doc, item)
    // A list keeps its style: `[a, b]` on one line, or one item per line.
    if (isSeq(node) && kept !== undefined) node.flow = /^[^:\n]*:[ \t]*\[/.test(kept)
    doc.set(item.key, node)
    out += doc.toString({ lineWidth: 0, flowCollectionPadding: false })
  }
  return ['---', ...out.replace(/\n$/, '').split('\n'), '---', ''].join(eol)
}

/** A head edited as YAML text (when it does not parse as properties). */
export function writeYaml(head: string, yaml: string): string {
  const eol = head.includes('\r\n') ? '\r\n' : '\n'
  if (yaml === headYaml(head)) return head
  if (!yaml.trim()) return ''
  return ['---', ...yaml.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n'), '---', ''].join(eol)
}
