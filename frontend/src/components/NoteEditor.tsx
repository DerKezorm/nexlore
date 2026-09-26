/** Markdown editor on CodeMirror 6, with completion for [[wiki links]]. */
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete'
import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView, placeholder } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { minimalSetup } from 'codemirror'
import { useEffect, useRef } from 'react'

import i18n from '../i18n'

const theme = EditorView.theme({
  '&': { color: 'var(--color-mist-200)', backgroundColor: 'transparent' },
  '.cm-content': { caretColor: 'var(--color-accent-500)', padding: '0 0 40vh' },
  '.cm-cursor': { borderLeftColor: 'var(--color-accent-500)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--color-accent-500) 25%, transparent)' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-tooltip': { border: '1px solid var(--color-ink-700)', backgroundColor: 'var(--color-ink-900)', borderRadius: '10px', overflow: 'hidden' },
  '.cm-tooltip-autocomplete ul li': { padding: '4px 10px', color: 'var(--color-mist-300)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'color-mix(in srgb, var(--color-accent-500) 18%, transparent)', color: 'var(--color-mist-100)' },
})

const highlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.45em', fontWeight: '700', color: 'var(--color-mist-100)' },
  { tag: tags.heading2, fontSize: '1.2em', fontWeight: '650', color: 'var(--color-mist-100)' },
  { tag: tags.heading3, fontWeight: '650', color: 'var(--color-mist-100)' },
  { tag: tags.strong, fontWeight: '700', color: 'var(--color-mist-100)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: 'var(--color-accent-400)' },
  { tag: tags.url, color: 'var(--color-mist-500)' },
  { tag: tags.monospace, color: 'var(--color-warn-500)' },
  { tag: tags.quote, color: 'var(--color-mist-400)' },
  { tag: [tags.processingInstruction, tags.list, tags.contentSeparator], color: 'var(--color-mist-600)' },
])

type Props = { value: string; titles: string[]; readOnly?: boolean; onChange: (value: string) => void }

export function NoteEditor({ value, titles, readOnly = false, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef({ onChange, titles })
  latest.current = { onChange, titles }

  useEffect(() => {
    const completeLinks = (context: CompletionContext) => {
      const before = context.matchBefore(/\[\[[^\]\n]*/)
      if (!before) return null
      return {
        from: before.from + 2,
        options: latest.current.titles.map((title) => ({ label: title, apply: title + ']]', type: 'text' })),
        validFor: /^[^\]\n]*$/,
      }
    }
    const editor = new EditorView({
      doc: value,
      parent: host.current!,
      extensions: [
        minimalSetup,
        markdown(),
        syntaxHighlighting(highlight),
        EditorView.lineWrapping,
        autocompletion({ override: [completeLinks], icons: false }),
        placeholder(i18n.t('note.editorPlaceholder')),
        EditorView.editable.of(!readOnly),
        theme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) latest.current.onChange(update.state.doc.toString())
        }),
      ],
    })
    view.current = editor
    if (!readOnly) editor.focus()
    return () => editor.destroy()
    // The editor is created once per note; the parent gives it a new key when the note changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly])

  return <div ref={host} className="nn-editor h-full" />
}
