/**
 * The keys while drawing, on whatever holds the surface and its toolbar (`lib/ink` decides what each key means:
 * `inkKey`). Space held moves the picture. Typing in a field, or in the note around a block, is never taken.
 */
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import { removeStrokes } from '../lib/ink'
import { inkKey, pressTool, type Tools } from './logic'
import type { InkController } from './useInk'

type Handlers = { onEscape?: () => void; onShowAll?: () => void }

function typing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  return !!element && (element.isContentEditable || !!element.closest?.('input, textarea, select'))
}

export function inkKeys(ink: InkController, tools: Tools, setTools: (next: Tools) => void, handlers: Handlers) {
  return {
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (typing(event.target)) return
      if (event.key === ' ') {
        ink.space.current = true
        event.preventDefault()
        event.stopPropagation()
        return
      }
      const action = inkKey(event)
      if (!action) return
      const writable = !ink.readonly
      if ('tool' in action) {
        if (!writable) return
        setTools(pressTool(tools, action.tool).tools)
        if (action.tool !== 'lasso') ink.select([])
      } else if (action.act === 'undo') {
        if (writable) ink.undo()
      } else if (action.act === 'redo') {
        if (writable) ink.redo()
      } else if (action.act === 'delete') {
        if (!writable || !ink.selection.length) return
        ink.commit(removeStrokes(ink.strokes, ink.selection))
        ink.select([])
      } else if (action.act === 'escape') {
        if (ink.selection.length) ink.select([])
        else if (handlers.onEscape) handlers.onEscape()
        else return
      } else if (action.act === 'showAll') {
        if (!handlers.onShowAll) return
        handlers.onShowAll()
      }
      event.preventDefault()
      event.stopPropagation()
    },
    onKeyUp: (event: ReactKeyboardEvent) => {
      if (event.key === ' ') ink.space.current = false
    },
    onBlur: () => {
      ink.space.current = false
    },
  }
}
