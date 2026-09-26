/**
 * Live preview of Obsidian's syntax, the way Obsidian itself does it: the text stays in the document exactly as
 * written, decorations only change how it looks.
 *
 * - `[[Target|Alias]]` shows `Alias` in turquoise; `[[Target]]` shows `Target`. A missing target is paler and
 *   dashed. With the cursor inside or at the edge, the brackets appear and the link is edited as text.
 * - `![[…]]` looks like a chip, `==…==` is highlighted, `%%…%%` is pale, `#tag` a pill, `^block-id` pale.
 * - A quote starting with `[!type]` is a callout; its marker becomes a label until the cursor is on that line.
 *
 * A click on a link opens it (Ctrl or Cmd: in a new tab); inline code and code blocks are left alone.
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'

export type LinkHelpers = {
  /** Does a wiki link target (`Name`, `Folder/Name`, `Name#Heading`) point at an existing note or file? */
  exists: (target: string) => boolean
  open: (target: string, newTab: boolean) => void
}

export const liveKey = new PluginKey<DecorationSet>('nxLive')

const LEAF = '\ufffc'
const WIKI = /(!?)\[\[([^[\]\n]+?)\]\]/g
const HIGHLIGHT = /(?<![=\\])==(?=[^\s=])([^\n]*?[^\s=])==(?!=)/g
const COMMENT = /%%[\s\S]*?%%/g
const TAG = /(?<![\p{L}\p{N}_&/\\#])#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*/gu
const BLOCK_ID = /(?:^|\s)(\^[A-Za-z0-9-]+)$/
const CALLOUT = /^\[!([\w-]+)\]([+-]?)/

/** Target and label of the inside of a wiki link; `\|` is the pipe Obsidian writes in tables. */
export function parseWiki(inner: string): { target: string; label: string; aliasAt: number } {
  const pipe = /(?<!\\)\|/.exec(inner)
  const target = (pipe ? inner.slice(0, pipe.index) : inner).replace(/\\$/, '')
  const label = pipe ? inner.slice(pipe.index + 1) : target
  return { target: target.trim(), label, aliasAt: pipe ? pipe.index + 1 : 0 }
}

function touches(state: EditorState, from: number, to: number): boolean {
  const { from: a, to: b } = state.selection
  return a <= to && b >= from
}

function build(state: EditorState, helpers: LinkHelpers): DecorationSet {
  const decorations: Decoration[] = []
  const code = state.schema.marks.inlineCode ?? state.schema.marks.code
  const hide = (from: number, to: number) => from < to && decorations.push(Decoration.inline(from, to, { class: 'nx-hide' }))
  const dim = (from: number, to: number) => from < to && decorations.push(Decoration.inline(from, to, { class: 'nx-syntax' }))

  state.doc.descendants((node: ProseNode, pos: number) => {
    if (node.type.name === 'code_block' || node.type.spec.code) return false
    if (node.type.name === 'blockquote') callout(node, pos)
    if (!node.isTextblock) return true
    const text = node.textBetween(0, node.content.size, undefined, LEAF)
    const start = pos + 1
    const inCode = (from: number, to: number) => !!code && state.doc.rangeHasMark(from, to, code)
    const taken: [number, number][] = []
    const free = (from: number, to: number) => !taken.some(([a, b]) => from < b && to > a)

    for (const match of text.matchAll(WIKI)) {
      const from = start + match.index
      const to = from + match[0].length
      if (inCode(from, to)) continue
      taken.push([from, to])
      const embed = match[1] === '!'
      const { target, aliasAt } = parseWiki(match[2])
      const missing = !helpers.exists(target)
      const open = from + match[1].length + 2
      const close = to - 2
      const cls = ['nx-wiki', embed ? 'nx-embed' : '', missing ? 'nx-wiki-missing' : ''].filter(Boolean).join(' ')
      if (touches(state, from, to)) {
        dim(from, open)
        dim(close, to)
        decorations.push(Decoration.inline(open, close, { class: cls + ' nx-wiki-editing', 'data-target': target }))
      } else {
        const labelFrom = aliasAt ? open + aliasAt : open
        hide(from, labelFrom)
        hide(close, to)
        decorations.push(Decoration.inline(labelFrom, close, { class: cls, 'data-target': target }))
      }
    }
    for (const match of text.matchAll(HIGHLIGHT)) {
      const from = start + match.index
      const to = from + match[0].length
      if (!free(from, to) || inCode(from, to)) continue
      taken.push([from, to])
      if (touches(state, from, to)) {
        dim(from, from + 2)
        dim(to - 2, to)
      } else {
        hide(from, from + 2)
        hide(to - 2, to)
      }
      decorations.push(Decoration.inline(from + 2, to - 2, { class: 'nx-highlight' }))
    }
    for (const match of text.matchAll(COMMENT)) {
      const from = start + match.index
      const to = from + match[0].length
      if (!free(from, to) || inCode(from, to)) continue
      taken.push([from, to])
      decorations.push(Decoration.inline(from, to, { class: 'nx-comment' }))
    }
    for (const match of text.matchAll(TAG)) {
      const from = start + match.index
      const to = from + match[0].length
      if (!free(from, to) || inCode(from, to)) continue
      decorations.push(Decoration.inline(from, to, { class: 'nx-tag' }))
    }
    const id = BLOCK_ID.exec(text)
    if (id) {
      const to = start + text.length
      const from = to - id[1].length
      if (free(from, to)) decorations.push(Decoration.inline(from, to, { class: 'nx-blockid' }))
    }
    return false
  })

  function callout(quote: ProseNode, pos: number) {
    const first = quote.firstChild
    if (!first || first.type.name !== 'paragraph') return
    const text = first.textBetween(0, first.content.size, undefined, LEAF)
    const marker = CALLOUT.exec(text)
    if (!marker) return
    const type = marker[1].toLowerCase()
    decorations.push(Decoration.node(pos, pos + quote.nodeSize, { class: `nx-callout nx-callout-${type}`, 'data-callout': type }))
    const from = pos + 2
    const to = from + marker[0].length
    const lineEnd = text.indexOf('\n')
    const titleTo = from + (lineEnd < 0 ? text.length : lineEnd)
    if (touches(state, from, titleTo)) {
      decorations.push(Decoration.inline(from, to, { class: 'nx-callout-marker' }))
    } else {
      hide(from, to)
      decorations.push(
        Decoration.widget(from, () => {
          const label = document.createElement('span')
          label.className = 'nx-callout-label'
          label.textContent = type
          return label
        }, { side: -1, key: `callout-${type}-${marker[2]}` }),
      )
    }
    if (titleTo > to) decorations.push(Decoration.inline(to, titleTo, { class: 'nx-callout-title' }))
  }

  return DecorationSet.create(state.doc, decorations)
}

export function livePreview(helpers: () => LinkHelpers) {
  return new Plugin<DecorationSet>({
    key: liveKey,
    state: {
      init: (_, state) => build(state, helpers()),
      apply: (tr, value, _old, state) => (tr.docChanged || tr.selectionSet || tr.getMeta(liveKey) ? build(state, helpers()) : value),
    },
    props: {
      decorations: (state) => liveKey.getState(state),
      handleClick: (view: EditorView, _pos: number, event: MouseEvent) => {
        const link = (event.target as HTMLElement | null)?.closest?.('.nx-wiki[data-target]:not(.nx-wiki-editing)')
        if (!link || !view.dom.contains(link)) return false
        event.preventDefault()
        helpers().open(link.getAttribute('data-target') ?? '', event.ctrlKey || event.metaKey)
        return true
      },
    },
  })
}

/** Redraw the decorations, for instance when the list of existing notes changed. */
export function refreshLive(view: EditorView) {
  view.dispatch(view.state.tr.setMeta(liveKey, true))
}
