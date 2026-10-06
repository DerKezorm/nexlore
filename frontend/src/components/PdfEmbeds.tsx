/**
 * PDFs embedded in the reading view (`![[Doc.pdf]]`, `![[Doc.pdf#page=3&height=400]]`): `renderMarkdown` leaves a
 * holder with a link to the PDF in it; each holder gets a small reader here, at that page and that height, as
 * Obsidian shows it. The PDF comes with the reader's own rights, like the link would open it.
 */
import { useLayoutEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'

import { fileRoute } from '../lib/markdown'
import { heightOf, pageOf } from '../lib/pdfFrame'
import { PdfView } from './PdfView'

/** More PDFs than this in one note stay links: each is a frame of its own with the whole PDF in it. */
export const MAX_PDF_EMBEDS = 6

type Holder = { holder: HTMLElement; path: string; section: string; key: string }

export function PdfEmbeds({ article, html }: { article: RefObject<HTMLElement | null>; html: string }) {
  const navigate = useNavigate()
  const [holders, setHolders] = useState<Holder[]>([])
  useLayoutEffect(() => {
    const found: Holder[] = []
    article.current?.querySelectorAll<HTMLElement>('.nn-embed-pdf[data-pdf]').forEach((holder, index) => {
      if (index >= MAX_PDF_EMBEDS) return
      holder.replaceChildren()
      found.push({ holder, path: holder.dataset.pdf!, section: holder.dataset.section ?? '', key: `${index}-${holder.dataset.pdf}-${holder.dataset.section}` })
    })
    setHolders(found)
  }, [article, html])
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
          item.key,
        ),
      )}
    </>
  )
}
