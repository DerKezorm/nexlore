/**
 * What the review before 1.0.0 found in the file the editor writes (PG notes): a changed word must change only that
 * word, whatever Obsidian syntax stands next to it, and typed text must not come out with backslashes.
 */
import { TextSelection } from '@milkdown/kit/prose/state'
import { afterEach, describe, expect, it } from 'vitest'

import '../styles/editor.css'
import { openEditor, replaceWord } from './harness'

type Open = Awaited<ReturnType<typeof openEditor>>
let open: Open | null = null
afterEach(async () => {
  await open?.close()
  open = null
})

/** Types ``words`` at the end of the first paragraph whose text contains ``after``. */
function typeAfter(view: Open['view'], after: string, words: string): void {
  let end = -1
  view.state.doc.descendants((node, pos) => {
    if (end >= 0) return false
    if (node.type.name === 'paragraph' && node.textContent.includes(after)) {
      end = pos + node.nodeSize - 1
      return false
    }
    return true
  })
  expect(end).toBeGreaterThan(0)
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)).insertText(words))
}

describe('a changed word changes only that word', () => {
  const cases: Record<string, [string, string, string]> = {
    'a Dataview field in brackets (P2.2)': ['Status [key:: value] und mehr.\n\nInline-Feld:: Wert\n', 'Status', 'Stand'],
    'a callout with a list inside (P2.8)': ['> [!note] Titel\n> Satz davor.\n> - eins\n> - zwei\n', 'davor', 'vorher'],
    'a table cell, the delimiter row as written (P2.7)': ['| A | B |\n|:-|-:|\n| x | y |\n', 'x', 'z'],
    'a hard break of two blanks (P2.7)': ['Zeile eins  \nZeile zwei\n', 'eins', 'drei'],
    'a non-breaking space written as entity (P2.6)': ['Preis&nbsp;10 Euro\n', 'Euro', 'Mark'],
    'blank lines at the end of the file (P2.5)': ['Text hier.\n\n\n', 'hier', 'dort'],
    'no line break at the end of the file (P2.5)': ['Text hier.', 'hier', 'dort'],
    'an address with underscores, www and mail (P3.3)': ['Siehe https://example.com/seite_eins und www.example.org oder mail@example.com, snake_case.\n', 'Siehe', 'Vgl.'],
  }
  for (const [name, [text, find, replace]] of Object.entries(cases)) {
    it(name, async () => {
      open = await openEditor(text)
      expect(replaceWord(open.view, find, replace)).toBe(true)
      expect(open.text()).toBe(text.replace(find, replace))
    })
  }
})

describe('typed text is written without backslashes (P3.3)', () => {
  it('keeps addresses, mail, www and snake_case as typed, so they stay links', async () => {
    open = await openEditor('Anfang.\n')
    typeAfter(open.view, 'Anfang', ' Siehe https://example.com/seite_eins und www.example.org danach, mail@example.com und snake_case.')
    const written = open.text()
    expect(written).toContain('https://example.com/seite_eins')
    expect(written).toContain('www.example.org')
    expect(written).toContain('mail@example.com')
    expect(written).toContain('snake_case')
    expect(written).not.toContain('\\')
  })

  it('keeps a typed Dataview field in brackets (P2.2)', async () => {
    open = await openEditor('Anfang.\n')
    typeAfter(open.view, 'Anfang', ' [key:: value] Text')
    expect(open.text()).toBe('Anfang. [key:: value] Text\n')
  })

  it('still escapes what would turn into something else', async () => {
    open = await openEditor('Anfang.\n')
    typeAfter(open.view, 'Anfang', ' *nicht kursiv* und [Text](nicht-link)')
    expect(open.text()).toContain('\\*nicht kursiv\\*')
    expect(open.text()).toContain('\\[Text]')
  })
})

describe('a single line break shows as a line break, as in Obsidian (P2.9)', () => {
  it('shows two lines, and the file keeps its single break', async () => {
    open = await openEditor('Eine Zeile\n\nZeile eins\nZeile zwei\n')
    const [one, two] = [...open.root.querySelectorAll('.ProseMirror p')] as HTMLElement[]
    expect(two.getBoundingClientRect().height).toBeGreaterThan(one.getBoundingClientRect().height * 1.5)
    expect(open.text()).toBe('Eine Zeile\n\nZeile eins\nZeile zwei\n')
  })
})
