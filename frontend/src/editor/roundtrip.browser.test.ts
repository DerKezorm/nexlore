/**
 * The editor against Obsidian-style files, in a real browser: unchanged files stay byte for byte, the editor itself
 * keeps Obsidian's syntax, and a changed word changes only its block.
 */
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, describe, expect, it } from 'vitest'

import { CORPUS, openEditor } from './harness'

type Open = Awaited<ReturnType<typeof openEditor>>
let open: Open | null = null
afterEach(async () => {
  await open?.close()
  open = null
})

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

describe('without a change', () => {
  for (const [name, text] of Object.entries(CORPUS)) {
    it(`${name} is written back byte for byte`, async () => {
      open = await openEditor(text)
      expect(open.text()).toBe(text)
    })
  }
})

/** What the editor itself must keep, before any block layer: Obsidian's syntax survives its own round trip. */
const MARKERS: Record<string, string[]> = {
  '04-aufgaben.md': ['- [ ] Server patchen', '- [x] Backup', '📅 2026-09-30', '#haushalt'],
  '05-tabelle.md': ['| :- | -: | :-: |', '| RAM | 32 | GB |'],
  '06-code.md': ['```python', '~~~'],
  '07-callouts.md': ['> [!note] Hinweis', '> [!warning]- Eingeklappt'],
  '08-wikilinks.md': ['[[Projekt Alpha]]', '[[Projekt Alpha|Alias]]', '[[Notiz#Überschrift]]', '[[Notiz#^block-id|Blockverweis]]'],
  '09-einbettungen.md': ['![[Diagramm.png]]', '![[Andere Notiz]]', '![[Bild.jpg|300]]', '![Markdown-Bild](Anhänge/foto.webp)'],
  '11-html.md': ['<span style="color:red">rot</span>', '<details>', '<summary>Mehr</summary>'],
  '12-fussnoten.md': ['[^1]', '[^quelle]: Mit Namen.'],
  '13-mathe.md': ['$E = mc^2$', '$$\n\\int_0^1'],
  '14-dataview.md': ['```dataview', 'FROM #projekt', '`= this.file.name`', '<%* tR += tp.date.now() %>'],
  '15-escapes.md': ['\\*nicht kursiv\\*', '1\\. keine Liste', 'C:\\Users\\beispiel'],
  '16-tags-kommentare.md': ['#verschachtelt/tag', '%% Obsidian-Kommentar %%', '==markiert=='],
  '18-links.md': ['[Beispiel](https://example.com)', '[ref]: https://example.com/ref', '[Referenz][ref]', 'https://example.net nackt'],
  '22-lang-gemischt.md': ['> [!tip] Tipp', '[[Link|Alias]]', '| 1 | [[x]] |', '[^f]: Fuß.'],
}

describe("the editor's own Markdown", () => {
  for (const [name, markers] of Object.entries(MARKERS)) {
    it(`${name} keeps Obsidian's syntax`, async () => {
      open = await openEditor(CORPUS[name])
      const out = open.markdown()
      for (const marker of markers) expect(out, marker).toContain(marker)
    })
  }
})

/** One word changed per file: the result is the original with exactly that word changed. */
const EDITS: Record<string, [string, string]> = {
  '01-absaetze.md': ['Zweiter', 'Dritter'],
  '02-listen-stern.md': ['Einkauf', 'Einkaufen'],
  '03-listen-strich.md': ['eins', 'erstens'],
  '04-aufgaben.md': ['Server', 'Rechner'],
  '06-code.md': ['Vorher', 'Zuvor'],
  '07-callouts.md': ['Normales', 'Schlichtes'],
  '08-wikilinks.md': ['Siehe', 'Vergleiche'],
  '09-einbettungen.md': ['Diagramm', 'Schaubild'],
  '12-fussnoten.md': ['Eine', 'Diese'],
  '14-dataview.md': ['Übersicht', 'Liste'],
  '15-escapes.md': ['Pfad', 'Ort'],
  '16-tags-kommentare.md': ['Text', 'Satz'],
  '17-trenner-ueberschriften.md': ['Titel', 'Kopf'],
  '18-links.md': ['und', 'sowie'],
  '19-crlf.md': ['zwei', 'drei'],
  '22-lang-gemischt.md': ['Gemischt', 'Bunt'],
}

/** Where the changed block is rightly written a little differently. */
const EXPECTED: Record<string, (text: string) => string> = {
  // A setext underline follows the new length of its heading.
  '17-trenner-ueberschriften.md': (text) => text.replace('Titel\n=====', 'Kopf\n===='),
}

describe('one word changed', () => {
  for (const [name, [find, replace]] of Object.entries(EDITS)) {
    it(`${name}: only that word differs`, async () => {
      const text = CORPUS[name]
      open = await openEditor(text)
      expect(replaceWord(open.view, find, replace)).toBe(true)
      expect(open.text()).toBe(EXPECTED[name]?.(text) ?? text.replace(find, replace))
    })
  }
})
