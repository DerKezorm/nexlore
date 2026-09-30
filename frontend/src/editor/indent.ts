/**
 * Shift+Tab stays in the editor (review before 1.0.0, P3.8): in a code block it takes the indentation off the line,
 * elsewhere (a paragraph, a heading) it does nothing. Before, it sent the focus to the button above the editor, and
 * what was typed next went nowhere, or a blank pressed that button. Lists and tables keep their own Shift+Tab (they
 * come first); Escape still leaves the editor for the keyboard.
 */
import { keymap } from '@milkdown/kit/prose/keymap'
import type { Command } from '@milkdown/kit/prose/state'

/** The indentation at the start of the caret's line in a code block goes: a tab, or up to four blanks. */
export const dedentCodeLine: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!$from.parent.type.spec.code || !empty) return false
  const text = $from.parent.textContent
  const lineStart = text.lastIndexOf('\n', $from.parentOffset - 1) + 1
  const indent = /^(\t| {1,4})/.exec(text.slice(lineStart))?.[0] ?? ''
  if (indent && dispatch) {
    const from = $from.start() + lineStart
    dispatch(state.tr.delete(from, from + indent.length))
  }
  return true
}

export function keepShiftTab() {
  return keymap({
    'Shift-Tab': (state, dispatch) => {
      if (dedentCodeLine(state, dispatch)) return true
      // In a list item the list's own lifting comes first; reaching here means nothing else wanted the key.
      return true
    },
  })
}
