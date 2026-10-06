/**
 * Live preview of Obsidian's syntax, the way Obsidian itself does it: the text stays in the document exactly as
 * written, decorations only change how it looks.
 *
 * - `[[Target|Alias]]` shows `Alias` in turquoise; `[[Target]]` shows `Target`, `[[Note#Heading]]` shows
 *   `Note › Heading`. A missing target is paler and dashed. With the cursor inside or at the edge, the brackets
 *   appear and the link is edited as text.
 * - `![[…]]` of a picture, a video or a sound shows it (`|300` is its width); a click on it, or the cursor, brings
 *   the text back. Any other embed looks like a chip (a size is not shown as a caption).
 * - `==…==` is highlighted, `%%…%%` is pale, `#tag` a pill (after a blank or at the start, as the server counts
 *   tags), `^block-id` pale.
 * - A quote starting with `[!type]` is a callout; its marker becomes a label until the cursor is on that line.
 *
 * Only what changed is worked out again: after typing, the top-level block that changed; after a cursor move, the
 * blocks the cursor left and entered. A long note stays quick, and every search here is linear in the text.
 *
 * A click on a link opens it (Ctrl or Cmd: in a new tab); inline code and code blocks are left alone.
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'

import i18n from '../i18n'

/**
 * What an embedded file shows in place of its link. For a PDF `url` is its path in the vault: the editor's page fills
 * the holder with a reader (`editor/pdfWidgets.tsx`), at the page and the height the link names.
 */
export type EmbedShown = { url: string; kind: 'image' | 'video' | 'audio' | 'pdf' }

export type LinkHelpers = {
  /** Does a wiki link target (`Name`, `Folder/Name`, `Name#Heading`) point at an existing note or file? */
  exists: (target: string) => boolean
  open: (target: string, newTab: boolean) => void
  /**
   * What `![[target]]` shows: a picture, a video, a sound or a PDF's reader; null for a chip (a note, nothing found);
   * undefined while it is not known yet (the helper asks, and the page redraws with `refresh` when it knows).
   */
  embed?: (target: string) => EmbedShown | null | undefined
}

/** The holder of an embedded PDF; its reader comes from the page, the editor never looks inside. */
function pdfHolder(shown: EmbedShown, target: string): HTMLElement {
  const element = document.createElement('div')
  element.className = 'nx-embed-pdf'
  element.setAttribute('data-pdf', shown.url)
  element.setAttribute('data-section', target.includes('#') ? target.slice(target.indexOf('#') + 1) : '')
  element.setAttribute('contenteditable', 'false')
  return element
}

function mediaElement(shown: EmbedShown, width: string, target: string): HTMLElement {
  if (shown.kind === 'pdf') return pdfHolder(shown, target)
  const element = document.createElement(shown.kind === 'image' ? 'img' : shown.kind)
  element.className = 'nx-embed-media'
  element.setAttribute('src', shown.url)
  element.setAttribute('data-embed', target)
  if (shown.kind === 'image') {
    element.setAttribute('alt', target)
    element.setAttribute('draggable', 'false')
  } else {
    element.setAttribute('controls', '')
    element.setAttribute('preload', 'metadata')
  }
  if (width) element.style.width = `${width}px`
  return element
}

export const liveKey = new PluginKey<DecorationSet>('nxLive')

const LEAF = '\ufffc'
const WIKI = /(!?)\[\[([^[\]\n]+?)\]\]/g
const COMMENT = /%%[\s\S]*?%%/g
const TAG = /(?<![^\s])#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*/gu
const BLOCK_ID = /(?:^|\s)(\^[A-Za-z0-9-]+)$/
const CALLOUT = /^\[!([\w-]+)\]([+-]?)/
const SIZE = /^\d+(x\d+)?$/

/** Target and label of the inside of a wiki link; `\|` is the pipe Obsidian writes in tables. */
export function parseWiki(inner: string): { target: string; label: string; aliasAt: number } {
  // The first pipe, escaped or not; the backslash of an escaped one is cut off the target below.
  const pipe = /\|/.exec(inner)
  const target = (pipe ? inner.slice(0, pipe.index) : inner).replace(/\\$/, '')
  const label = pipe ? inner.slice(pipe.index + 1) : target
  return { target: target.trim(), label, aliasAt: pipe ? pipe.index + 1 : 0 }
}

/**
 * Highlights `==…==` in one pass: an opening `==` has no blank after it, a closing one none before it, and neither
 * touches another `=`. Pairs each opening with the next closing on the same line (a regex with a lazy middle was
 * quadratic on lines full of unclosed `==`).
 */
export function highlights(text: string): [number, number][] {
  const out: [number, number][] = []
  let open = -1
  for (let at = text.indexOf('=='); at >= 0; at = text.indexOf('==', at + 1)) {
    const before = text[at - 1]
    const after = text[at + 2]
    if (before === '=' || after === '=' || before === '\\') continue
    if (open >= 0 && text.slice(open, at).includes('\n')) open = -1
    if (open >= 0 && at > open + 2 && before !== undefined && !/\s/.test(before)) {
      out.push([open, at + 2])
      open = -1
      at += 1
    } else if (after !== undefined && !/\s/.test(after)) open = at
  }
  return out
}

function touches(state: EditorState, from: number, to: number): boolean {
  const { from: a, to: b } = state.selection
  return a <= to && b >= from
}

/** Decorations for one top-level block at `start` (its position in the document). */
function decorateBlock(state: EditorState, block: ProseNode, start: number, helpers: LinkHelpers, decorations: Decoration[]) {
  const code = state.schema.marks.inlineCode ?? state.schema.marks.code
  const hide = (from: number, to: number) => from < to && decorations.push(Decoration.inline(from, to, { class: 'nx-hide' }))
  const dim = (from: number, to: number) => from < to && decorations.push(Decoration.inline(from, to, { class: 'nx-syntax' }))

  const visit = (node: ProseNode, pos: number): boolean => {
    if (node.type.name === 'code_block' || node.type.spec.code) return false
    if (node.type.name === 'blockquote') callout(node, pos)
    if (!node.isTextblock) return true
    const text = node.textBetween(0, node.content.size, undefined, LEAF)
    const begin = pos + 1
    const inCode = (from: number, to: number) => !!code && state.doc.rangeHasMark(from, to, code)
    const taken: [number, number][] = []
    const free = (from: number, to: number) => !taken.some(([a, b]) => from < b && to > a)

    for (const match of text.matchAll(WIKI)) {
      const from = begin + match.index
      const to = from + match[0].length
      if (inCode(from, to)) continue
      taken.push([from, to])
      const embed = match[1] === '!'
      const { target, label, aliasAt } = parseWiki(match[2])
      const missing = !helpers.exists(target)
      const open = from + match[1].length + 2
      const close = to - 2
      const cls = ['nx-wiki', embed ? 'nx-embed' : '', missing ? 'nx-wiki-missing' : ''].filter(Boolean).join(' ')
      if (touches(state, from, to)) {
        dim(from, open)
        dim(close, to)
        decorations.push(Decoration.inline(open, close, { class: cls + ' nx-wiki-editing', 'data-target': target }))
        continue
      }
      // An embed's `|300` or `|300x200` is its size, not a caption: the name is shown.
      const sized = embed && aliasAt && SIZE.test(label.trim())
      // A picture, a video or a sound shows itself; its text comes back when the cursor enters it.
      const media = embed ? helpers.embed?.(target) : null
      if (media) {
        hide(from, to)
        const width = sized ? label.trim().split('x')[0] : ''
        decorations.push(
          media.kind === 'pdf'
            ? // A reader keeps its own clicks and keys (its page field, its buttons): none of them edits the note.
              Decoration.widget(to, () => mediaElement(media, width, target), { side: -1, key: `pdf:${media.url}:${target}`, stopEvent: () => true, ignoreSelection: true })
            : Decoration.widget(to, () => mediaElement(media, width, target), { side: -1, key: `embed:${media.url}:${width}` }),
        )
        continue
      }
      const labelFrom = aliasAt && !sized ? open + aliasAt : open
      const labelTo = sized ? open + aliasAt - 1 : close
      hide(from, labelFrom)
      hide(labelTo, to)
      decorations.push(Decoration.inline(labelFrom, labelTo, { class: cls, 'data-target': target }))
      // `Note#Heading` reads `Note › Heading`, `#^block` is a block, `#Heading` alone a heading of this note.
      if (!aliasAt || sized) {
        const inner = match[2].slice(0, sized ? aliasAt - 1 : undefined)
        const hash = inner.indexOf('#')
        // A PDF's page reads `Doc.pdf, page 4`, as in the reading view; the rest (`&height=…`) is not shown.
        const pdfPage = hash > 0 && /\.pdf$/i.test(inner.slice(0, hash)) ? /^page=(\d{1,6})/.exec(inner.slice(hash + 1)) : null
        if (pdfPage) {
          hide(open + hash, open + hash + 1 + 'page='.length)
          const after = open + hash + 1 + pdfPage[0].length
          if (after < open + inner.length) hide(after, open + inner.length)
          decorations.push(
            Decoration.widget(open + hash, () => {
              const word = document.createElement('span')
              word.className = 'nx-wiki nx-subpath'
              word.textContent = `, ${i18n.t('pdf.pageWord') || 'page'} `
              return word
            }, { side: 1, key: 'pdf-page' }),
          )
        } else if (hash >= 0) {
          const mark = inner[hash + 1] === '^' ? 2 : 1
          hide(open + hash, open + hash + mark)
          if (hash > 0) {
            decorations.push(
              Decoration.widget(open + hash, () => {
                const arrow = document.createElement('span')
                arrow.className = 'nx-wiki nx-subpath'
                arrow.textContent = ' › '
                return arrow
              }, { side: 1, key: 'subpath' }),
            )
          }
        }
      }
    }
    for (const [a, b] of highlights(text)) {
      const from = begin + a
      const to = begin + b
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
      const from = begin + match.index
      const to = from + match[0].length
      if (!free(from, to) || inCode(from, to)) continue
      taken.push([from, to])
      decorations.push(Decoration.inline(from, to, { class: 'nx-comment' }))
    }
    for (const match of text.matchAll(TAG)) {
      const from = begin + match.index
      const to = from + match[0].length
      if (!free(from, to) || inCode(from, to)) continue
      decorations.push(Decoration.inline(from, to, { class: 'nx-tag' }))
    }
    const id = BLOCK_ID.exec(text)
    if (id) {
      const to = begin + text.length
      const from = to - id[1].length
      if (free(from, to)) decorations.push(Decoration.inline(from, to, { class: 'nx-blockid' }))
    }
    return false
  }

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
    // The title ends at the first line break. Milkdown keeps a soft break as a node of its own (`hardbreak`), not
    // as "\n"; it would show as a space, so the text below the title is set on a line of its own, as in Obsidian.
    let lineEnd = text.indexOf('\n')
    let offset = 0
    first.forEach((child) => {
      if (child.type.name === 'hardbreak' && (lineEnd < 0 || offset < lineEnd)) {
        lineEnd = offset
        decorations.push(Decoration.inline(from + offset, from + offset + child.nodeSize, { class: 'nx-callout-break' }))
      }
      offset += child.nodeSize
    })
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

  if (visit(block, start)) block.descendants((node, pos) => visit(node, start + 1 + pos))
}

/** Every decoration of the document at once (the start, a refresh; tests compare the step by step result with it). */
export function build(state: EditorState, helpers: LinkHelpers): DecorationSet {
  const decorations: Decoration[] = []
  state.doc.forEach((block, offset) => decorateBlock(state, block, offset, helpers, decorations))
  return DecorationSet.create(state.doc, decorations)
}

/** The top-level blocks that overlap a range, as [from, to] in the document. */
function blocksAround(doc: ProseNode, from: number, to: number, into: Map<number, number>) {
  doc.forEach((block, offset) => {
    const end = offset + block.nodeSize
    if (end >= from && offset <= to) into.set(offset, end)
  })
}

function update(tr: Transaction, previous: DecorationSet, old: EditorState, state: EditorState, helpers: LinkHelpers): DecorationSet {
  if (tr.getMeta(liveKey)) return build(state, helpers)
  if (!tr.docChanged && !tr.selectionSet) return previous
  const dirty = new Map<number, number>()
  let set = previous
  if (tr.docChanged) {
    set = previous.map(tr.mapping, tr.doc)
    tr.mapping.maps.forEach((map, index) => {
      const after = tr.mapping.slice(index + 1)
      map.forEach((_a, _b, from, to) => blocksAround(state.doc, after.map(from, -1), after.map(to, 1), dirty))
    })
  }
  // The cursor left one place and came to another: both may show or hide syntax now.
  const before = old.selection
  blocksAround(state.doc, tr.mapping.map(before.from, -1), tr.mapping.map(before.to, 1), dirty)
  blocksAround(state.doc, state.selection.from, state.selection.to, dirty)
  const fresh: Decoration[] = []
  for (const [from, to] of dirty) {
    set = set.remove(set.find(from, to, () => true).filter((decoration) => decoration.from >= from && decoration.to <= to))
    const block = state.doc.nodeAt(from)
    if (block) decorateBlock(state, block, from, helpers, fresh)
  }
  return set.add(state.doc, fresh)
}

export function livePreview(helpers: () => LinkHelpers) {
  return new Plugin<DecorationSet>({
    key: liveKey,
    state: {
      init: (_, state) => build(state, helpers()),
      apply: (tr, value, old, state) => update(tr, value, old, state, helpers()),
    },
    props: {
      decorations: (state) => liveKey.getState(state),
      handleClick: (view: EditorView, _pos: number, event: MouseEvent) => {
        // Only the main button: the right one opens the editor's menu, not the link.
        if (event.button !== 0) return false
        // A click on an embedded picture puts the cursor into its link, which then shows as text to edit.
        const media = (event.target as HTMLElement | null)?.closest?.('.nx-embed-media')
        if (media && view.dom.contains(media)) {
          const at = view.posAtDOM(media, 0)
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, Math.max(0, at - 2))))
          view.focus()
          return true
        }
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
