/**
 * The long test against data loss.
 *
 * 1. The cases measured in M0, one by one: a word changed in exactly the block that holds the difficult thing, and
 *    the difficult thing is still there, written as before.
 * 2. Random editing: typing (with Markdown and Obsidian characters), deleting, splitting and joining blocks, bold,
 *    new and removed blocks, on every corpus file. After every step the text that would be saved is opened in a
 *    fresh editor, which must show exactly what the first one shows (nothing lost, nothing added), and saving that
 *    again unchanged must give the same bytes.
 *
 * More rounds: `VITE_SOAK_ROUNDS=200 VITE_SOAK_SEEDS=10 npm run test:browser -- soak` (the seed is in every failure).
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, describe, expect, it } from 'vitest'

import { CORPUS, openEditor, replaceWord } from './harness'

type Open = Awaited<ReturnType<typeof openEditor>>
const opened: Open[] = []
afterEach(async () => {
  for (const editor of opened.splice(0)) await editor.close()
})
async function open(text: string): Promise<Open> {
  const editor = await openEditor(text)
  opened.push(editor)
  return editor
}

const CASES = CORPUS['23-gemessene-faelle.md']

describe('the measured cases, each edited in its own block', () => {
  const cases: [string, string, string, (RegExp | string)[]][] = [
    ['setext heading stays underlined', 'Titel', 'Kopf', [/^Kopf mit Linie\n=+\n/m]],
    ['an inline image with a relative path stays', 'mitten', 'genau', ['Ein Bild ![Foto vom Regal](Anhänge/regal.webp) genau im Satz.']],
    ['Templater stays unescaped', 'now', 'today', ['<%* tR += tp.date.today("YYYY-MM-DD") %>']],
    ['a tilde fence stays a tilde fence', 'tilde', 'wellen', ['~~~bash\necho wellen\n~~~']],
    ['indented code stays indented', 'zweite', 'dritte', ['    eingerückter Code\n    dritte Zeile']],
    ['bare and angled web addresses stay as they were', 'Nackt', 'Bloß', ['Bloß https://example.net/pfad und in Klammern <https://example.org>.']],
    ['table alignment stays', 'Alpha', 'Omega', [/\| :-+ \| -+: \| :-+: \|/, '| Omega | Beta | Gamma |']],
    ['reference links and their definitions stay', 'Mit', 'Samt', ['Samt [Referenz][ref] und ![Bildref][bild].', '[ref]: https://example.com/ref "Titel"', '[bild]: Anhänge/ref.png']],
    ['a list indented with tabs keeps its tabs', 'zweiter', 'dritter', ['- Liste\n\t- mit Tab eingerückt\n\t- dritter']],
    ['the rest of a fence line stays', 'wert', 'zahl', ['```js title="beispiel.js"\nconst zahl = 1\n```']],
    ['a math block stays a math block', 'c^2', 'd^2', ['$$\na^2 + b^2 = d^2\n$$']],
    ['a callout keeps its marker, highlight and comment', 'Inhalt', 'Text', ['> [!warning]- Eingeklappt\n> Text mit ==Markierung== und %% Kommentar %%.']],
    ['a tag at the start of a line stays a tag', 'Satzende', 'Schluss', ['#tag am Zeilenanfang und Schluss ^block-1']],
    ['a wiki link with alias in a table keeps its escaped pipe', 'Zelle', 'Feld', ['| [[Ziel\\|Alias]] | Feld |']],
  ]
  for (const [title, find, replace, expected] of cases) {
    it(title, async () => {
      const editor = await open(CASES)
      expect(replaceWord(editor.view, find, replace), `"${find}" not found`).toBe(true)
      const out = editor.text()
      for (const want of expected) {
        if (typeof want === 'string') expect(out).toContain(want)
        else expect(out).toMatch(want)
      }
      // Everything else is byte for byte as it was.
      const before = CASES.split('\n')
      const after = out.split('\n')
      const changed = after.filter((line) => !before.includes(line))
      expect(changed.length, changed.join('\n')).toBeLessThanOrEqual(3)
    })
  }

  it('an image alone in its paragraph survives text typed next to it', async () => {
    const editor = await open(CASES)
    let at = -1
    editor.view.state.doc.descendants((node, pos) => {
      if (at < 0 && node.type.name === 'image' && node.attrs.src === 'Anhänge/foto.webp') at = pos + node.nodeSize
      return at < 0
    })
    expect(at).toBeGreaterThan(0)
    editor.view.dispatch(editor.view.state.tr.insertText(' Nachsatz', at))
    expect(editor.text()).toContain('![Markdown-Bild](Anhänge/foto.webp) Nachsatz')
  })
})

/** A small deterministic random source, so a failure can be replayed from its seed. */
function random(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T,>(list: T[]): T => list[Math.floor(next() * list.length)] }
}

const WORDS = [
  'Wort', 'ä', 'Straße', '*', '_', '**', '[', ']', '#', '#neu', '|', '<', '>', '\\', '$', '==', '[[Ziel]]', '[[Ziel|Alias]]',
  '![[Bild.png]]', '%%', '`', '~', '1.', '-', '+', '&amp;', '🙂', 'https://example.com/x', '^id', '<%', '%>', '  ', 'x',
]

function textblocks(doc: ProseNode): { from: number; to: number; node: ProseNode }[] {
  const out: { from: number; to: number; node: ProseNode }[] = []
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      out.push({ from: pos + 1, to: pos + 1 + node.content.size, node })
      return false
    }
    return true
  })
  return out
}

/** A cursor never stands between the two halves of an emoji; a random position must not either. */
function whole(doc: ProseNode, pos: number): number {
  if (pos <= 0) return pos
  const before = doc.textBetween(pos - 1, pos, undefined, '\ufffc')
  return /[\ud800-\udbff]/.test(before) ? pos - 1 : pos
}

type Step = (view: EditorView, rng: ReturnType<typeof random>) => string | null

const STEPS: Record<string, Step> = {
  type: (view, rng) => {
    const block = rng.pick(textblocks(view.state.doc))
    if (!block) return null
    const at = whole(view.state.doc, block.from + rng.int(block.to - block.from + 1))
    const word = rng.pick(WORDS) + (rng.next() < 0.5 ? ' ' : '')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)).insertText(word))
    return `type ${JSON.stringify(word)} at ${at}`
  },
  delete: (view, rng) => {
    const block = rng.pick(textblocks(view.state.doc).filter((b) => b.to > b.from))
    if (!block) return null
    const from = whole(view.state.doc, block.from + rng.int(block.to - block.from))
    const to = whole(view.state.doc, Math.min(block.to, from + 1 + rng.int(6)))
    view.dispatch(view.state.tr.delete(from, to))
    return `delete ${from}-${to}`
  },
  split: (view, rng) => {
    const block = rng.pick(textblocks(view.state.doc).filter((b) => !b.node.type.spec.code))
    if (!block) return null
    const at = whole(view.state.doc, block.from + rng.int(block.to - block.from + 1))
    try {
      view.dispatch(view.state.tr.split(at))
    } catch {
      return null
    }
    return `split at ${at}`
  },
  join: (view, rng) => {
    const blocks = textblocks(view.state.doc)
    if (blocks.length < 2) return null
    const index = 1 + rng.int(blocks.length - 1)
    const from = blocks[index - 1].to
    const to = blocks[index].from
    try {
      view.dispatch(view.state.tr.delete(from, to))
    } catch {
      return null
    }
    return `join ${from}-${to}`
  },
  bold: (view, rng) => {
    const block = rng.pick(textblocks(view.state.doc).filter((b) => b.to > b.from && !b.node.type.spec.code))
    const strong = view.state.schema.marks.strong
    if (!block || !strong) return null
    const from = whole(view.state.doc, block.from + rng.int(block.to - block.from))
    const to = whole(view.state.doc, Math.min(block.to, from + 1 + rng.int(8)))
    view.dispatch(view.state.tr.addMark(from, to, strong.create()))
    return `bold ${from}-${to}`
  },
  paragraph: (view, rng) => {
    const { doc, schema } = view.state
    let at = 0
    const target = rng.int(doc.childCount + 1)
    for (let i = 0; i < target; i++) at += doc.child(i).nodeSize
    const text = [rng.pick(WORDS), 'neuer', rng.pick(WORDS), 'Absatz'].join(' ')
    view.dispatch(view.state.tr.insert(at, schema.nodes.paragraph.create(null, schema.text(text))))
    return `paragraph ${JSON.stringify(text)} at ${at}`
  },
  remove: (view, rng) => {
    const { doc } = view.state
    if (doc.childCount < 2) return null
    const index = rng.int(doc.childCount)
    let at = 0
    for (let i = 0; i < index; i++) at += doc.child(i).nodeSize
    view.dispatch(view.state.tr.delete(at, at + doc.child(index).nodeSize))
    return `remove block ${index}`
  },
}

const WEIGHTS: [string, number][] = [['type', 5], ['delete', 3], ['split', 2], ['join', 2], ['bold', 1], ['paragraph', 1], ['remove', 1]]

function chooseStep(rng: ReturnType<typeof random>): string {
  const total = WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0)
  let roll = rng.next() * total
  for (const [name, weight] of WEIGHTS) {
    roll -= weight
    if (roll < 0) return name
  }
  return 'type'
}

/** Attributes that change what a person sees; the rest (list spacing, fence character, …) is style. */
const VISIBLE_ATTRS: Record<string, string[]> = {
  heading: ['level'],
  // Not listType: an item joined into another list keeps it, the list around it decides what is shown and saved.
  list_item: ['checked'],
  ordered_list: ['order'],
  code_block: ['language'],
  image: ['src', 'alt', 'title'],
  html: ['value'],
  math_inline: ['value'],
  nx_raw_block: ['value'],
  nx_raw_inline: ['value'],
  table_cell: ['alignment'],
  table_header: ['alignment'],
  footnote_reference: ['label'],
  footnote_definition: ['label'],
}
const VISIBLE_MARK_ATTRS: Record<string, string[]> = { link: ['href', 'title'] }

/**
 * What a person sees, as a string: node types, text with its marks, and the attributes above. Empty paragraphs do
 * not count (Markdown has no way to keep them; the file keeps the blank lines instead). Neighbouring text with the
 * same marks is one run.
 */
/** A paragraph with nothing in it but blanks: Markdown keeps no such paragraph. */
function isBlank(paragraph: ProseNode): boolean {
  let blank = true
  paragraph.forEach((child) => {
    if (!child.isText || (child.text ?? '').trim()) blank = false
  })
  return blank
}

function visible(node: ProseNode): string {
  const attrs = (VISIBLE_ATTRS[node.type.name] ?? []).map((key) => `${key}=${JSON.stringify(node.attrs[key] ?? null)}`)
  const head = `${node.type.name}${attrs.length ? `[${attrs.join(',')}]` : ''}`
  if (node.isTextblock && !node.type.spec.code) return `${head}(${inline(node)})`
  if (node.isTextblock) return `${head}(${JSON.stringify(node.textContent)})`
  const parts: string[] = []
  node.forEach((child) => {
    if (child.type.name === 'paragraph' && isBlank(child)) return
    parts.push(visible(child))
  })
  return `${head}(${parts.join(' ')})`
}

/**
 * The inside of a paragraph or heading as runs of text with the same marks. Seen alike, because Markdown cannot
 * tell them apart: a hard break and a line break in the text; blanks at the start and end of the block, and next to
 * a line break (Markdown drops them); blanks at the edge of a mark (`** x **` is no bold, they move outside); a link
 * whose text is its address and plain text of an address (GFM links it on reading).
 */
function inline(block: ProseNode): string {
  type Run = { text: string; marks: string } | { atom: string }
  const runs: Run[] = []
  const push = (text: string, marks: string) => {
    const last = runs.at(-1)
    if (last && 'text' in last && last.marks === marks) last.text += text
    else runs.push({ text, marks })
  }
  block.forEach((child) => {
    if (child.type.name === 'hardbreak') return push(block.type.name === 'heading' ? ' ' : '\n', '')
    if (!child.isText) return void runs.push({ atom: visible(child) })
    // A heading is one line in Markdown: a line break in it is written as a blank.
    const text = block.type.name === 'heading' ? (child.text ?? '').replace(/\n/g, ' ') : (child.text ?? '')
    const marks = child.marks
      .filter((mark) => !(mark.type.name === 'link' && mark.attrs.href === text))
      .map((mark) => mark.type.name + (VISIBLE_MARK_ATTRS[mark.type.name] ?? []).map((key) => `(${mark.attrs[key] ?? ''})`).join(''))
      .sort()
      .join('+')
    if (!marks) return push(text, '')
    const [, lead, body, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!
    if (lead) push(lead, '')
    if (body) push(body, marks)
    if (trail) push(trail, '')
  })
  const out = runs
    .map((run) => ('atom' in run ? run.atom : `${JSON.stringify(run.text)}${run.marks ? `{${run.marks}}` : ''}`))
    .join(' ')
  return out
    .replace(/[ \t]+(\\n)/g, '$1')
    .replace(/(\\n)[ \t]+/g, '$1')
    .replace(/^"\s+/, '"')
    .replace(/\s+"$/, '"')
    .replace(/(^| )""( |$)/g, ' ')
    .trim()
}

/** Every letter and digit a person can see, with how often: text, raw Markdown, HTML, formulas, image and link addresses. */
function lettersShown(doc: ProseNode): string {
  const parts: string[] = []
  // Link targets apart from the text: a typed address that becomes a link on reading (GFM) has target = text.
  // A link is a run of neighbouring text with the same target (other marks may split it into several nodes).
  let link: { href: string; text: string } | null = null
  const endLink = () => {
    if (link && link.href !== link.text) parts.push(link.href)
    link = null
  }
  doc.descendants((node) => {
    if (node.isText) {
      parts.push(node.text ?? '')
      const href = node.marks.find((mark) => mark.type.name === 'link')?.attrs.href as string | undefined
      if (href === undefined) endLink()
      else if (link && link.href === href) link.text += node.text
      else {
        endLink()
        link = { href, text: node.text ?? '' }
      }
      return true
    }
    endLink()
    for (const key of ['value', 'src', 'alt', 'title', 'language']) if (typeof node.attrs[key] === 'string') parts.push(node.attrs[key])
    // A list item's label is its bullet or number, drawn by the editor, not content.
    if (node.type.name.startsWith('footnote') && typeof node.attrs.label === 'string') parts.push(node.attrs.label)
    return true
  })
  endLink()
  const counts = new Map<string, number>()
  for (const char of parts.join(' ').matchAll(/[\p{L}\p{N}]/gu)) counts.set(char[0], (counts.get(char[0]) ?? 0) + 1)
  return [...counts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([char, count]) => `${char}${count}`).join(' ')
}

/** Structure differences, collected; only those Markdown itself cannot avoid are allowed (see `explained`). */
const drift: string[] = []

/**
 * The structure differences Markdown itself causes, looked at one by one (26.09.2026); nothing is lost in them:
 * - HTML: an editor shows inline HTML as its source; written back, a tag at the start of a line opens an HTML block
 *   (`<summary>`), so the same source is cut into other pieces.
 * - A footnote reference whose definition was deleted is plain text in GFM (`[^quelle]`).
 * - `$…$` typed inside Templater (`<% … %>`, kept exactly as written) is a formula on reading.
 * - The same for a reference link (`[text][ref]`) whose definition was deleted.
 * - A wiki link typed with `|` in a table cell is written `[[x\|y]]` (Obsidian's way); read back, the backslash
 *   is part of the text, and the link shows the same.
 * - Bold inside a bare web address: GFM takes the stars into the address.
 */
function explained(entry: string): boolean {
  const [, shown = '', after = ''] = /--- shown structure:\n([\s\S]*?)\n--- after reopening:\n([\s\S]*)$/.exec(entry) ?? []
  let start = 0
  while (start < shown.length && shown[start] === after[start]) start++
  let end = 0
  while (end < shown.length - start && end < after.length - start && shown[shown.length - 1 - end] === after[after.length - 1 - end]) end++
  const a = shown.slice(Math.max(0, start - 200), shown.length - end + 40)
  const b = after.slice(Math.max(0, start - 200), after.length - end + 40)
  if (a.includes('html[') || b.includes('html[')) return true
  const count = (text: string, word: string) => text.split(word).length - 1
  if (count(shown, 'footnote_reference') > count(after, 'footnote_reference') && b.includes('[^')) return true
  if (b.includes('math_inline') && !a.includes('math_inline') && a.includes('<%')) return true
  // A reference link whose definition was deleted is text.
  if (count(shown, 'nx_raw_inline') > count(after, 'nx_raw_inline')) {
    const labels = [...shown.matchAll(/nx_raw_inline\[value="!?\[([^\]]*)\](?:\[([^\]]*)\])?"\]/g)].map((m) => (m[2] || m[1]).toLowerCase())
    const defined = (label: string) => shown.toLowerCase().includes(`nx_raw_block[value="[${label}]:`)
    if (labels.some((label) => !defined(label))) return true
  }
  // In a table a wiki link's pipe is written `\|`; the editor keeps the backslash as typed text.
  const pipes = (text: string) => text.replace(/(\[\[[^\]]*?)\\\\\|/g, '$1|')
  if (pipes(shown) === pipes(after)) return true
  // Bold inside a bare web address: GFM takes the stars into the address.
  if ((a + b).includes('https://') && a.includes('{strong}') && b.includes('**')) return true
  return false
}

const ROUNDS = Number(import.meta.env.VITE_SOAK_ROUNDS ?? 25)
const SEEDS = Number(import.meta.env.VITE_SOAK_SEEDS ?? 2)

const ONLY = import.meta.env.VITE_SOAK_ONLY as string | undefined // "file.md:seed" replays one failure

describe('random editing', () => {
  for (const [name, text] of Object.entries(CORPUS)) {
    for (let seed = 1; seed <= SEEDS; seed++) {
      if (ONLY && ONLY !== `${name}:${seed}`) continue
      it(`${name}, seed ${seed}: what is saved is what is shown`, async () => {
        const rng = random(seed * 7919 + name.length)
        const editor = await open(text)
        const log: string[] = []
        for (let round = 0; round < ROUNDS; round++) {
          const step = chooseStep(rng)
          const done = STEPS[step](editor.view, rng)
          if (!done) continue
          log.push(done)
          const saved = editor.text()
          const fresh = await openEditor(saved)
          try {
            const context = `${name} seed ${seed}\n${log.join('\n')}\n--- shown:\n${editor.markdown()}\n--- saved:\n${saved}`
            // Nothing lost, nothing doubled: hard.
            expect(lettersShown(fresh.view.state.doc), context).toBe(lettersShown(editor.view.state.doc))
            // Opening and saving again without a change gives the same bytes: hard.
            expect(fresh.text(), context).toBe(saved)
            // The same structure: collected (Markdown cannot say everything an editor can, see STRUCTURE below).
            const a = visible(editor.view.state.doc)
            const b = visible(fresh.view.state.doc)
            if (a !== b) drift.push(`${context}\n--- shown structure:\n${a}\n--- after reopening:\n${b}`)
          } finally {
            await fresh.close()
          }
        }
      })
    }
  }
})

describe('structure after random editing', () => {
  it('is reported', () => {
    const unexplained = drift.filter((entry) => !explained(entry))
    expect(unexplained.length, unexplained.join('\n\n=====\n\n')).toBe(0)
  })
})
