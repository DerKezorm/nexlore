/**
 * The block layer against an invented editor whose quirks are chosen, so every path of the matching is reached on
 * purpose: a block the editor splits in two, one it drops, one it writes differently alone than in context.
 */
import { describe, expect, it } from 'vitest'

import { Plan, type Block, type Tools } from './blocks'

/** Blocks are separated by blank lines. */
function blocks(text: string): Block[] {
  const out: Block[] = []
  const re = /\S(?:[\s\S]*?)(?=\r?\n(?:[ \t]*\r?\n)+|\s*$)/g
  for (let match = re.exec(text); match; match = re.exec(text)) out.push({ start: match.index, end: match.index + match[0].length })
  return out
}

/**
 * The invented editor: `DROP …` has no node and disappears; `CTX a b` becomes the blocks `a` and `b` in a document,
 * but `alone CTX a b` when it is the only block (so the block, run through the editor on its own, matches nothing);
 * anything else is kept, with runs of blanks made one: so a block copied from the original can be told from one the
 * editor wrote.
 */
function serialize(text: string): string {
  const found = blocks(text).map((block) => text.slice(block.start, block.end).replace(/\r\n/g, '\n'))
  const out: string[] = []
  for (const block of found) {
    if (block.startsWith('DROP')) continue
    if (block.startsWith('CTX ')) {
      if (found.length === 1) out.push('alone ' + block)
      else out.push(...block.slice(4).split(' '))
      continue
    }
    out.push(block.replace(/ {2,}/g, ' '))
  }
  return out.length ? out.join('\n\n') + '\n' : ''
}

const tools: Tools = { blocks, serialize }

/** What the block layer writes when the editor's document is `edited` (as the editor would write it). */
function save(original: string, edited: string, maxCells?: number): string {
  return new Plan(original, tools, maxCells).apply(edited, tools)
}

describe('the invented editor', () => {
  it('behaves as described', () => {
    expect(serialize('A\n\nCTX x y\n\nDROP z\n\nB\n')).toBe('A\n\nx\n\ny\n\nB\n')
    expect(serialize('CTX x y')).toBe('alone CTX x y\n')
  })
})

for (const [label, maxCells] of [['by table', undefined], ['by window', 0]] as const) {
  describe(`matching ${label}`, () => {
    it('gives the original back when nothing changed', () => {
      const original = 'A\r\n\r\nCTX x y\r\n\r\nDROP z\r\n\r\n\r\nB'
      expect(save(original, serialize(original), maxCells)).toBe(original)
    })

    it('keeps the text of blocks that only changed places', () => {
      // Both ways round: whichever of the two the matching takes as moved, it comes from the original.
      expect(save('Up  one\n\nDown  two\n\nEnd\n', 'Down two\n\nUp one\n\nEnd\n', maxCells)).toBe('Down  two\n\nUp  one\n\nEnd\n')
      expect(save('First\n\nSecond  x\n\nThird  y\n', 'Third y\n\nFirst\n\nSecond x\n', maxCells)).toBe('Third  y\n\nFirst\n\nSecond  x\n')
      // A moved block that was also changed is the editor's, as any changed block.
      expect(save('Up  one\n\nDown  two\n', 'Down two!\n\nUp one\n', maxCells)).toBe('Down two!\n\nUp  one\n')
      // Part of an original block the editor splits in two moved away: the editor's text for it, nothing twice.
      expect(save('A\n\nCTX x y\n\nB\n', 'x\n\nA\n\ny\n\nB\n', maxCells)).toBe('x\n\nA\n\ny\n\nB\n')
    })

    it('keeps a new block typed between two parts of one original block', () => {
      const original = 'A\n\nCTX x y\n\nB\n'
      expect(serialize(original)).toBe('A\n\nx\n\ny\n\nB\n')
      expect(save(original, 'A\n\nx\n\nNEW\n\ny\n\nB\n', maxCells)).toBe('A\n\nx\n\nNEW\n\ny\n\nB\n')
    })

    it('keeps a block the editor cannot show when the unit around it changes', () => {
      const original = 'A\n\nCTX one\n\nDROP secret\n\nCTX two\n\nB\n'
      expect(serialize(original)).toBe('A\n\none\n\ntwo\n\nB\n')
      expect(save(original, 'A\n\nONE\n\ntwo\n\nB\n', maxCells)).toBe('A\n\nONE\n\ntwo\n\nDROP secret\n\nB\n')
    })

    it('keeps a change in the last part of an unmatched stretch', () => {
      const original = 'A\n\nCTX p q\n\nB\n'
      expect(save(original, 'A\n\np\n\nQ changed\n\nB\n', maxCells)).toBe('A\n\np\n\nQ changed\n\nB\n')
      // Both parts unchanged: the original block stays, the new one follows it.
      expect(save(original, 'A\n\np\n\nq\n\nNEW\n\nB\n', maxCells)).toBe('A\n\nCTX p q\n\nNEW\n\nB\n')
    })

    it('copies untouched blocks between two changes far apart from the original', () => {
      const middle = Array.from({ length: 30 }, (_, k) => `Para ${k}  with  two  blanks`)
      // The double blanks show that a block came from the original: the editor writes single ones.
      const original = ['First', ...middle, 'Last'].join('\n\n') + '\n'
      const edited = serialize(original).replace('First', 'First changed').replace('Last', 'Last changed')
      const expected = original.replace('First', 'First changed').replace('Last', 'Last changed')
      expect(save(original, edited, maxCells)).toBe(expected)
      const crlf = original.replace(/\n/g, '\r\n')
      expect(save(crlf, edited, maxCells)).toBe(expected.replace(/\n/g, '\r\n'))
    })

    it('matches the blocks between two stretches the editor writes differently', () => {
      const original = 'A\n\nCTX p\n\nX  keep  blanks\n\nCTX q\n\nB\n'
      expect(serialize(original)).toBe('A\n\np\n\nX keep blanks\n\nq\n\nB\n')
      expect(save(original, 'A\n\nP\n\nX keep blanks\n\nq\n\nB\n', maxCells)).toBe('A\n\nP\n\nX  keep  blanks\n\nCTX q\n\nB\n')
    })
  })
}
