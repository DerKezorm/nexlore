/**
 * A PDF's pages one below the other, as wide as the frame, nothing to scroll: a PDF on a canvas card. The same frame
 * as the reader (`/pdfview.html`, no origin, no network; `PdfView.tsx`), opened as a strip of at most `STRIP_PAGES`
 * pages. The frame says how tall the strip is at its width (`onHeight`): the card grows to it. Nothing in it takes the
 * pointer: the card is moved, chosen and opened like a picture.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { fileUrl } from '../api/client'
import { STRIP_PAGES, frameData, type Colours, type FromFrame, type ToFrame } from '../lib/pdfFrame'
import { THEME_EVENT } from '../lib/theme'

function colours(): Colours {
  const style = getComputedStyle(document.documentElement)
  const take = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    ground: take('--color-ink-900', '#101016'),
    panel: take('--color-ink-900', '#101016'),
    text: take('--color-mist-200', '#dcdce4'),
    muted: take('--color-mist-500', '#9a9aa8'),
    accent: take('--color-accent-400', '#5eead4'),
    line: take('--color-ink-700', '#26262f'),
  }
}

type Props = {
  path: string
  /** How much sharper than its width the pages are drawn (the canvas's zoom and the screen). */
  sharp: number
  /** The strip's height at the frame's width, each time it changes. */
  onHeight: (height: number) => void
  /** The number of pages, once the PDF is open. */
  onPages?: (pages: number) => void
  /** How many pages at most (a card folded to its first page: 1); without it `STRIP_PAGES`. */
  pages?: number
}

export function PdfPages({ path, sharp, onHeight, onPages, pages = STRIP_PAGES }: Props) {
  const { t } = useTranslation()
  const frame = useRef<HTMLIFrameElement>(null)
  const [failed, setFailed] = useState(false)
  const told = useRef({ onHeight, onPages })
  told.current = { onHeight, onPages }
  const name = path.slice(path.lastIndexOf('/') + 1)

  useEffect(() => {
    setFailed(false)
    const say = (message: ToFrame, transfer: Transferable[] = []) => frame.current?.contentWindow?.postMessage(message, '*', transfer)
    const bytes = fetch(fileUrl(path), { credentials: 'same-origin' }).then((response) => {
      if (!response.ok) throw new Error(String(response.status))
      return response.arrayBuffer()
    })
    bytes.catch(() => setFailed(true))
    const listen = (event: MessageEvent<FromFrame>) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const message = event.data
      if (!message || typeof message !== 'object') return
      if (message.type === 'ready') {
        void bytes.then(
          (data) => {
            const copy = data.slice(0)
            say(
              {
                type: 'open', data: copy, page: 1, colours: colours(), sidebar: false, compact: true, strip: pages,
                texts: {
                  pages: t('pdf.pages'), contents: t('pdf.contents'), noContents: t('pdf.noContents'),
                  password: t('pdf.password'), broken: t('pdf.broken'), page: t('pdf.pageLabel'), more: t('pdf.morePages'),
                },
              },
              [copy],
            )
          },
          () => undefined,
        )
      } else if (message.type === 'height' && Number.isFinite(message.height) && message.height > 0) {
        told.current.onHeight(Math.min(message.height, 200_000))
      } else if (message.type === 'loaded') {
        told.current.onPages?.(message.pages)
      } else if (message.type === 'failed') {
        setFailed(true)
      } else if (message.type === 'data') {
        void frameData(message).then((data) => say({ type: 'data', id: message.id, bytes: data }, data ? [data] : []))
      }
    }
    window.addEventListener('message', listen)
    const repaint = () => say({ type: 'colours', colours: colours() })
    window.addEventListener(THEME_EVENT, repaint)
    return () => {
      window.removeEventListener('message', listen)
      window.removeEventListener(THEME_EVENT, repaint)
    }
    // The texts count when the frame opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, pages])

  // Sharper when the canvas zooms in; the frame draws again only for a change that shows.
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ type: 'sharp', factor: sharp } satisfies ToFrame, '*')
  }, [sharp])

  if (failed) return <p className="p-3 text-sm text-mist-500" data-pdf-failed="">{t('pdf.loadFailed')}</p>
  return (
    <iframe
      ref={frame}
      key={`${path}:${pages}`}
      src="/pdfview.html"
      sandbox="allow-scripts"
      title={t('pdf.frameTitle', { name })}
      className="pointer-events-none absolute inset-0 h-full w-full border-0"
      tabIndex={-1}
      data-testid="pdf-pages"
    />
  )
}
