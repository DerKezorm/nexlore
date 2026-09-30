/**
 * Words and characters of a note, for the line under it (Obsidian's word count): counted in what is shown, the
 * reading view without embedded notes or the editor's text, so front matter and hidden comments stay out.
 *
 * Words by `Intl.Segmenter`, so languages without spaces between words count as well; characters as a person counts
 * them (a letter with its accent is one), line breaks not.
 */

export type Count = { words: number; chars: number }

const words = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null
const letters = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

export function countWords(text: string): number {
  if (!words) return text.split(/\s+/).filter(Boolean).length
  let count = 0
  for (const part of words.segment(text)) if (part.isWordLike) count++
  return count
}

export function countChars(text: string): number {
  const plain = text.replace(/[\r\n]/g, '')
  if (!letters) return [...plain].length
  let count = 0
  for (const _ of letters.segment(plain)) count++
  return count
}

export function count(text: string): Count {
  return { words: countWords(text), chars: countChars(text) }
}

/** What is left out of a note's own words: notes embedded in it. */
export const NOT_COUNTED = '.nn-embedded'

/** Folded parts (`lib/folds.ts`) are the note's words all the same: shown for the moment they are counted. */
const MEASURING = 'nn-measuring'

/** The words shown in `root`, without what `NOT_COUNTED` finds in it; folded parts count. */
export function countIn(root: HTMLElement): Count {
  root.classList.add(MEASURING)
  const text = root.innerText
  root.classList.remove(MEASURING)
  const all = count(text)
  for (const skipped of root.querySelectorAll<HTMLElement>(NOT_COUNTED)) {
    const less = count(skipped.innerText)
    all.words -= less.words
    all.chars -= less.chars
  }
  return { words: Math.max(0, all.words), chars: Math.max(0, all.chars) }
}
