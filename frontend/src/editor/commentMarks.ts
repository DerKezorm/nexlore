/**
 * Comments in the editor: the words of each open thread marked in the text while writing, as in the reading view.
 * The page hands over the threads (`CommentControl.set`); each is found in the document's text by its words and what
 * stood around them (`lib/comments.locate`), and the marks then move with typing. A mark is an element with the
 * thread's id (`data-comment-thread`), so the page shows the thread's preview when the mouse rests on it.
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'

import { locate, PULSE, type Anchor } from '../lib/comments'

export type CommentAnchor = Anchor & { id: number }
type Mark = { id: number; from: number; to: number }
type State = { marks: Mark[]; current: number | null; decorations: DecorationSet }

export type CommentControl = {
  /** The open threads to mark; found anew in the text. */
  set: (anchors: CommentAnchor[]) => void
  /** Scroll to a thread's words and let them blink; false when they are not in the text. */
  reveal: (id: number) => boolean
  /** Which threads are marked now. */
  found: () => Set<number>
}

export const commentKey = new PluginKey<State>('nxComments')
type Meta = { anchors?: CommentAnchor[]; current?: number | null }

/** The text of the document, one line per text block, and where in the document each character stands. */
export function docText(doc: ProseNode): { text: string; at: (index: number) => number } {
  let text = ''
  const starts: number[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    if (text) {
      starts.push(text.length, -1)
      text += '\n'
    }
    node.forEach((child, offset) => {
      starts.push(text.length, pos + 1 + offset)
      text += child.isText ? child.text! : '￼'
    })
    return false
  })
  const at = (index: number): number => {
    let found = -1
    for (let i = 0; i < starts.length; i += 2) if (starts[i] <= index && starts[i + 1] >= 0) found = i
    return found < 0 ? 0 : starts[found + 1] + (index - starts[found])
  }
  return { text, at }
}

function find(doc: ProseNode, anchors: CommentAnchor[]): Mark[] {
  if (!anchors.length) return []
  const { text, at } = docText(doc)
  const marks: Mark[] = []
  for (const anchor of anchors) {
    const place = locate(text, anchor)
    if (place) marks.push({ id: anchor.id, from: at(place.start), to: at(place.end - 1) + 1 })
  }
  return marks
}

function decorate(doc: ProseNode, marks: Mark[], current: number | null): DecorationSet {
  return DecorationSet.create(
    doc,
    marks
      .filter((mark) => mark.to > mark.from)
      .map((mark) =>
        Decoration.inline(mark.from, mark.to, {
          class: 'nx-comment-mark' + (mark.id === current ? ' nx-comment-mark-current' : ''),
          'data-comment-thread': String(mark.id),
        }),
      ),
  )
}

export function commentPlugin(): Plugin<State> {
  return new Plugin<State>({
    key: commentKey,
    state: {
      init: () => ({ marks: [], current: null, decorations: DecorationSet.empty }),
      apply: (tr: Transaction, old: State, _before: EditorState, after: EditorState): State => {
        const meta = tr.getMeta(commentKey) as Meta | undefined
        let marks = old.marks
        let current = old.current
        if (meta?.anchors) marks = find(after.doc, meta.anchors)
        else if (tr.docChanged)
          // Typing moves the marks; words typed at their edges stay outside.
          marks = marks.map((mark) => ({ ...mark, from: tr.mapping.map(mark.from, 1), to: tr.mapping.map(mark.to, -1) }))
        if (meta && 'current' in meta) current = meta.current ?? null
        if (marks === old.marks && current === old.current) return old
        return { marks, current, decorations: decorate(after.doc, marks, current) }
      },
    },
    props: { decorations: (state) => commentKey.getState(state)?.decorations },
  })
}

let pulsing: number[] = []

export function commentControl(view: EditorView): CommentControl {
  const state = () => commentKey.getState(view.state)
  return {
    set: (anchors) => view.dispatch(view.state.tr.setMeta(commentKey, { anchors } satisfies Meta).setMeta('addToHistory', false)),
    found: () => new Set((state()?.marks ?? []).map((mark) => mark.id)),
    reveal: (id) => {
      const mark = state()?.marks.find((item) => item.id === id)
      if (!mark || view.isDestroyed) return false
      const element = view.domAtPos(mark.from).node
      ;(element instanceof Element ? element : element.parentElement)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      for (const timer of pulsing) window.clearTimeout(timer)
      pulsing = PULSE.map((at, index) =>
        window.setTimeout(() => {
          if (view.isDestroyed) return
          view.dispatch(view.state.tr.setMeta(commentKey, { current: index % 2 === 0 && index < PULSE.length - 1 ? id : null } satisfies Meta).setMeta('addToHistory', false))
        }, at),
      )
      return true
    },
  }
}
