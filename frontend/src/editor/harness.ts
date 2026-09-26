/**
 * For the browser tests: an editor in a fresh element, with plain labels. Like the note page, the front matter is
 * split off first and put back in front of what the editor writes.
 */
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

import { createEditor, type EditorLabels, type NoteEditor } from './editor'
import { splitNote } from './frontmatter'
import type { LinkHelpers } from './live'

export const LABELS: EditorLabels = {
  placeholder: 'Write',
  suggestions: 'Notes',
  slash: {
    text: 'Text', h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', quote: 'Quote', divider: 'Divider',
    bulletList: 'Bullet list', orderedList: 'Numbered list', taskList: 'Task list', code: 'Code', table: 'Table',
    math: 'Math', groupText: 'Text', groupList: 'Lists', groupAdvanced: 'More', groupObsidian: 'Obsidian',
    callout: 'Callout', wikiLink: 'Link to note', embed: 'Embed note',
  },
}

export async function openEditor(
  original: string,
  extra: { links?: Partial<LinkHelpers>; titles?: string[]; onChange?: () => void; plugins?: MilkdownPlugin[] } = {},
): Promise<NoteEditor & { root: HTMLElement; close: () => Promise<void> }> {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const links: LinkHelpers = { exists: () => true, open: () => undefined, ...extra.links }
  const titles = extra.titles ?? []
  const { head, body } = splitNote(original)
  const editor = await createEditor({
    root,
    original: body,
    labels: LABELS,
    links: () => links,
    search: () => (query) =>
      titles.filter((title) => title.toLowerCase().includes(query.toLowerCase())).map((title) => ({ label: title, detail: '', insert: title })),
    onChange: extra.onChange ?? (() => undefined),
    plugins: extra.plugins,
  })
  const text = editor.text
  const markdown = editor.markdown
  return Object.assign(editor, {
    text: () => head + text(),
    markdown: () => head + markdown(),
    root,
    close: async () => {
      await editor.destroy()
      root.remove()
    },
  })
}

/** Corpus files by name, bytes as on disk (CRLF included). */
export const CORPUS: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob('./corpus/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>).map(
    ([path, text]) => [path.replace('./corpus/', ''), text],
  ),
)

/** Replace the first occurrence of a word in the document's text, as typing would. */
export function replaceWord(view: EditorView, find: string, replace: string): boolean {
  let hit = -1
  view.state.doc.descendants((node, pos) => {
    if (hit >= 0) return false
    if (!node.isText) return true
    const at = node.text!.indexOf(find)
    if (at >= 0) hit = pos + at
    return false
  })
  if (hit < 0) return false
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, hit, hit + find.length)).insertText(replace))
  return true
}
