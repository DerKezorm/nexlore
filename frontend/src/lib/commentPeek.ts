/**
 * The state of a comment's preview over its words (`components/CommentPeek.tsx`), shared by the reading view and
 * the editor: which thread, where, and the timer that lets it go a moment after the mouse left it and the words.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import type { Thread } from '../api/client'

/** How long the preview waits before it goes, so the mouse can move onto it. */
export const LINGER_MS = 700

type Place = { thread: Thread; x: number; y: number }

export function usePeek() {
  const [peek, setPeek] = useState<Place | null>(null)
  const leave = useRef(0)
  // The mouse on the preview: nothing over the text closes it then.
  const onPeek = useRef(false)

  const show = useCallback((thread: Thread, box: DOMRect) => {
    window.clearTimeout(leave.current)
    setPeek((was) => (was?.thread.id === thread.id ? was : { thread, x: Math.min(box.left, window.innerWidth - 300), y: box.bottom }))
  }, [])
  const hideSoon = useCallback(() => {
    if (onPeek.current) return
    window.clearTimeout(leave.current)
    leave.current = window.setTimeout(() => !onPeek.current && setPeek(null), LINGER_MS)
  }, [])
  /** The mouse came onto the preview, or went off it. */
  const hold = useCallback(() => {
    onPeek.current = true
    window.clearTimeout(leave.current)
  }, [])
  const release = useCallback(() => {
    onPeek.current = false
    window.clearTimeout(leave.current)
    leave.current = window.setTimeout(() => !onPeek.current && setPeek(null), LINGER_MS)
  }, [])
  const hide = useCallback(() => {
    window.clearTimeout(leave.current)
    onPeek.current = false
    setPeek(null)
  }, [])

  // Scrolling moves the words away from a preview that stays where it was: it goes.
  useEffect(() => {
    if (!peek) return
    const gone = () => {
      onPeek.current = false
      setPeek(null)
    }
    window.addEventListener('scroll', gone, true)
    return () => window.removeEventListener('scroll', gone, true)
  }, [peek])
  useEffect(() => () => window.clearTimeout(leave.current), [])

  return { peek, show, hideSoon, hide, hold, release }
}

export type PeekState = ReturnType<typeof usePeek>
