/**
 * PDFs embedded in the editor (`![[Doc.pdf#page=3&height=400]]`), shown as a small reader while the cursor is not in
 * the link, as Obsidian's live preview shows them. `editor/live.ts` leaves a holder (`.nx-embed-pdf`); the readers
 * are put into the holders from here, inside the page's own React tree (so they keep its language and its routes).
 * A holder ProseMirror takes away (the cursor went into the link) takes its reader with it.
 */
import { useEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'

import { PdfView } from '../components/PdfView'
import { fileRoute } from '../lib/markdown'
import { heightOf, pageOf } from '../lib/pdfFrame'

type Holder = { holder: HTMLElement; path: string; section: string }

export function PdfWidgets({ host }: { host: RefObject<HTMLElement | null> }) {
  const navigate = useNavigate()
  const [holders, setHolders] = useState<Holder[]>([])
  useEffect(() => {
    const root = host.current
    if (!root) return
    const look = () => {
      const found = [...root.querySelectorAll<HTMLElement>('.nx-embed-pdf[data-pdf]')].slice(0, 6)
      setHolders((before) => {
        const same = before.length === found.length && before.every((item, at) => item.holder === found[at])
        return same ? before : found.map((holder) => ({ holder, path: holder.dataset.pdf!, section: holder.dataset.section ?? '' }))
      })
    }
    look()
    // Only holders coming and going count; what changes inside a reader is its own business.
    const watcher = new MutationObserver((changes) => {
      if (changes.some((change) => [...change.addedNodes, ...change.removedNodes].some((node) => node instanceof HTMLElement && (node.matches('.nx-embed-pdf') || !!node.querySelector('.nx-embed-pdf'))))) look()
    })
    watcher.observe(root, { childList: true, subtree: true })
    return () => watcher.disconnect()
  }, [host])
  return (
    <>
      {holders.map((item) =>
        createPortal(
          <PdfView
            path={item.path}
            page={pageOf(item.section)}
            height={heightOf(item.section)}
            compact
            onOpenLarge={(page) => navigate(fileRoute(item.path) + `#page=${page}`)}
          />,
          item.holder,
          `${item.path}#${item.section}`,
        ),
      )}
    </>
  )
}
