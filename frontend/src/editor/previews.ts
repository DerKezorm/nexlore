/**
 * Below a Mermaid block and a formula block (`$$ … $$`, a code block of the language LaTeX here) the editor shows what
 * they draw, as Obsidian's live preview does; the code above stays to edit. The drawing is done by `lib/enrich.ts`
 * (its libraries load the first time a note needs them) and redone only when the block's text changes.
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'

export const previewsKey = new PluginKey<DecorationSet>('nxPreviews')

type Kind = 'mermaid' | 'math'

function kindOf(node: ProseNode): Kind | null {
  if (node.type.name !== 'code_block') return null
  const language = String(node.attrs.language ?? '').toLowerCase()
  if (language === 'mermaid') return 'mermaid'
  if (language === 'latex') return 'math'
  return null
}

/** A short key for the text, so an unchanged block keeps its drawing while the rest of the note is typed in. */
function keyOf(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return (hash >>> 0).toString(36) + ':' + text.length
}

function preview(kind: Kind, text: string): HTMLElement {
  const box = document.createElement('div')
  box.className = kind === 'mermaid' ? 'nn-mermaid-preview' : 'nn-math-preview'
  box.contentEditable = 'false'
  box.dataset.state = 'loading'
  void import('../lib/enrich').then(async ({ mermaidSvg, mathHtml }) => {
    try {
      box.innerHTML = kind === 'mermaid' ? await mermaidSvg(text) : await mathHtml(text, true)
      box.dataset.state = 'shown'
    } catch {
      box.replaceChildren()
      box.dataset.state = 'failed'
    }
  })
  return box
}

function build(state: EditorState): DecorationSet {
  const found: Decoration[] = []
  state.doc.descendants((node, pos) => {
    const kind = kindOf(node)
    if (kind) {
      const text = node.textContent
      if (text.trim()) {
        found.push(Decoration.widget(pos + node.nodeSize, () => preview(kind, text), { side: -1, key: `${kind}:${keyOf(text)}`, ignoreSelection: true }))
      }
      return false
    }
    // Only blocks hold code blocks; text inside a paragraph needs no look.
    return node.isBlock && !node.isTextblock
  })
  return DecorationSet.create(state.doc, found)
}

export function blockPreviews() {
  return new Plugin<DecorationSet>({
    key: previewsKey,
    state: {
      init: (_, state) => build(state),
      apply: (tr, value, _old, state) => (tr.docChanged ? build(state) : value.map(tr.mapping, tr.doc)),
    },
    props: { decorations: (state) => previewsKey.getState(state) },
  })
}
