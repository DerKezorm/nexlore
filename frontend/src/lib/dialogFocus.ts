/**
 * What a dialog built from a `div` owes the keyboard (review before 1.0.0, P8.5): Escape closes it wherever the
 * focus is inside, Tab stays inside, and closing by Escape or its close button gives the focus back to where it was.
 * Picking something in it does not: what was picked takes the focus (a note, a folder in the sidebar).
 */
import { useCallback, useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function useDialogFocus(root: RefObject<HTMLElement | null>, onClose: () => void, aside: () => boolean = () => false): () => void {
  const close = useRef(onClose)
  close.current = onClose
  const standAside = useRef(aside)
  standAside.current = aside
  const before = useRef<HTMLElement | null>(null)

  const dismiss = useCallback(() => {
    const back = before.current
    close.current()
    // At once: a dialog opened right after (Escape, then Ctrl+P again) must not lose its focus to a late hand-back.
    if (back?.isConnected) back.focus()
  }, [])

  useEffect(() => {
    before.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const key = (event: KeyboardEvent) => {
      const box = root.current
      if (!box || standAside.current()) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        dismiss()
        return
      }
      if (event.key !== 'Tab') return
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.getClientRects().length > 0)
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      const at = document.activeElement
      if (!box.contains(at)) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && at === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && at === last) {
        event.preventDefault()
        first.focus()
      }
    }
    // Before anything on the page hears it: the page's own Escape and Tab must not act behind the dialog.
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [root, dismiss])

  return dismiss
}
