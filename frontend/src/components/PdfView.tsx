/**
 * A PDF in nexlore: the pages in a frame of their own (`/pdfview.html`, no origin, no network), the tools around it
 * here. The page fetches the PDF with the reader's session and hands it over; pdf.js never sees the session. The same
 * view serves the file's page (with pictures of the pages and its contents on the left), a PDF beside a note, and an
 * embed in a note (`compact`: smaller, without the left column, its height from `#height=`).
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { fileUrl } from '../api/client'
import { DATA_FOLDERS, openable, plainName, type Colours, type FromFrame, type ToFrame } from '../lib/pdfFrame'
import { copyText } from '../lib/vaultActions'
import { THEME_EVENT } from '../lib/theme'
import { Symbol } from './Symbol'

const SIDEBAR = 'nexlore.pdfSidebar'

function colours(): Colours {
  const style = getComputedStyle(document.documentElement)
  const take = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    ground: take('--color-ink-950', '#0b0b0f'),
    panel: take('--color-ink-900', '#101016'),
    text: take('--color-mist-200', '#dcdce4'),
    muted: take('--color-mist-500', '#9a9aa8'),
    accent: take('--color-accent-400', '#5eead4'),
    line: take('--color-ink-700', '#26262f'),
  }
}

function sidebarWanted(): boolean {
  try {
    return localStorage.getItem(SIDEBAR) !== 'off'
  } catch {
    return true
  }
}

type Props = {
  path: string
  /** The page to show; a change later turns to it. */
  page?: number
  compact?: boolean
  /** Height of an embed, in pixels. */
  height?: number
  onPage?: (page: number) => void
  /** More buttons at the end of the tools (beside, the right column, …). */
  tools?: ReactNode
  /** A compact view's way to the file's page. */
  onOpenLarge?: (page: number) => void
  /** Whether the pictures of the pages start open; left out, as last chosen. Beside a note there is little room. */
  side?: boolean
}

export function PdfView({ path, page = 1, compact = false, height, onPage, tools, onOpenLarge, side }: Props) {
  const { t } = useTranslation()
  const frame = useRef<HTMLIFrameElement>(null)
  const bytes = useRef<Promise<ArrayBuffer> | null>(null)
  const [pages, setPages] = useState(0)
  const [current, setCurrent] = useState(page)
  const [typed, setTyped] = useState(String(page))
  const [percent, setPercent] = useState(0)
  const [failed, setFailed] = useState<'password' | 'broken' | 'load' | null>(null)
  const [sidebar, setSidebar] = useState(() => side ?? sidebarWanted())
  const [finding, setFinding] = useState(false)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState({ current: 0, total: 0 })
  const [copied, setCopied] = useState(false)
  const findField = useRef<HTMLInputElement>(null)
  const name = path.slice(path.lastIndexOf('/') + 1)

  const say = useCallback((message: ToFrame, transfer: Transferable[] = []) => {
    // The frame has no origin of its own, so no other target than "*" reaches it; only this frame is spoken to.
    frame.current?.contentWindow?.postMessage(message, '*', transfer)
  }, [])

  // The PDF is fetched once per file, with the reader's session; the frame gets the bytes.
  useEffect(() => {
    setFailed(null)
    setPages(0)
    bytes.current = fetch(fileUrl(path), { credentials: 'same-origin' }).then((response) => {
      if (!response.ok) throw new Error(String(response.status))
      return response.arrayBuffer()
    })
    bytes.current.catch(() => setFailed('load'))
  }, [path])

  useEffect(() => {
    const listen = (event: MessageEvent<FromFrame>) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const message = event.data
      if (!message || typeof message !== 'object') return
      switch (message.type) {
        case 'ready':
          void bytes.current?.then(
            (data) => {
              const copy = data.slice(0)
              say({
                type: 'open', data: copy, page, colours: colours(), sidebar, compact,
                texts: {
                  pages: t('pdf.pages'), contents: t('pdf.contents'), noContents: t('pdf.noContents'),
                  password: t('pdf.password'), broken: t('pdf.broken'), page: t('pdf.pageLabel'),
                },
              }, [copy])
            },
            () => undefined,
          )
          break
        case 'loaded':
          setPages(message.pages)
          break
        case 'page':
          setCurrent(message.page)
          setTyped(String(message.page))
          onPage?.(message.page)
          break
        case 'scale':
          setPercent(message.percent)
          break
        case 'found':
          setFound({ current: message.current, total: message.total })
          break
        case 'link':
          if (openable(message.href)) window.open(message.href, '_blank', 'noopener,noreferrer')
          break
        case 'failed':
          setFailed(message.reason)
          break
        case 'findKey':
          if (!compact) {
            setFinding(true)
            setTimeout(() => findField.current?.focus(), 0)
          }
          break
        case 'data': {
          const folder = DATA_FOLDERS[message.kind]
          if (!folder || !plainName(message.name)) {
            say({ type: 'data', id: message.id, bytes: null })
            break
          }
          fetch(`/pdfjs/${folder}/${message.name}`).then(
            async (response) => {
              const data = response.ok ? await response.arrayBuffer() : null
              say({ type: 'data', id: message.id, bytes: data }, data ? [data] : [])
            },
            () => say({ type: 'data', id: message.id, bytes: null }),
          )
          break
        }
      }
    }
    window.addEventListener('message', listen)
    return () => window.removeEventListener('message', listen)
    // The first page, the sidebar and the texts count when the frame opens; later changes go by their own messages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [say, path])

  // Another page asked for from outside (a link in the note beside it, for example).
  useEffect(() => {
    if (pages > 0) say({ type: 'go', page })
  }, [page, pages, say])

  // The theme changed: the frame follows.
  useEffect(() => {
    const repaint = () => say({ type: 'colours', colours: colours() })
    window.addEventListener(THEME_EVENT, repaint)
    return () => window.removeEventListener(THEME_EVENT, repaint)
  }, [say])

  const go = (target: number) => {
    if (!pages) return
    const next = Math.min(pages, Math.max(1, target))
    say({ type: 'go', page: next })
  }
  const toggleSidebar = () => {
    const next = !sidebar
    setSidebar(next)
    say({ type: 'sidebar', show: next })
    try {
      localStorage.setItem(SIDEBAR, next ? 'on' : 'off')
    } catch {
      // Remembered next time only where the browser keeps it.
    }
  }
  const find = (previous: boolean, again: boolean) => {
    if (query.trim()) say({ type: 'find', query: query.trim(), previous, again })
  }
  const openFind = () => {
    setFinding(true)
    setTimeout(() => findField.current?.focus(), 0)
  }
  const copyPage = async () => {
    if (await copyText(`[[${name}#page=${current}]]`)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    }
  }

  const button = 'inline-grid h-8 w-8 shrink-0 place-items-center rounded-lg text-mist-300 hover:bg-ink-850 hover:text-accent-300 disabled:opacity-40'
  const ready = pages > 0 && !failed

  return (
    <div
      className={`flex min-h-0 flex-col overflow-hidden ${compact ? 'rounded-xl border border-ink-700' : 'h-full'}`}
      style={compact ? { height: height ?? 480 } : undefined}
      data-testid="pdf-view"
      data-page={current}
      data-pages={pages}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && !compact) {
          event.preventDefault()
          openFind()
        }
      }}
    >
      <div className="flex min-h-11 shrink-0 items-center gap-1 border-b border-ink-800 bg-ink-900 px-2" role="toolbar" aria-label={t('pdf.tools')}>
        {!compact && (
          <button type="button" className={button} onClick={toggleSidebar} aria-pressed={sidebar} title={t('pdf.sidebar')} aria-label={t('pdf.sidebar')}>
            <Symbol name="sidebar" className="h-4 w-4" />
          </button>
        )}
        <Symbol name="pdf" className="ml-1 h-4 w-4 shrink-0 text-accent-400" />
        <span className="min-w-0 truncate text-sm font-medium text-mist-200" title={name}>{name}</span>
        <span className="flex-1" />
        <div className="flex shrink-0 items-center gap-1 text-sm text-mist-300">
          <button type="button" className={button} onClick={() => go(current - 1)} disabled={!ready || current <= 1} aria-label={t('pdf.previous')} title={t('pdf.previous')}>
            <Symbol name="chevronUp" className="h-4 w-4" />
          </button>
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
            onKeyDown={(event) => event.key === 'Enter' && go(Number(typed) || 1)}
            onBlur={() => setTyped(String(current))}
            disabled={!ready}
            aria-label={t('pdf.pageField')}
            className="w-10 rounded-md border border-ink-700 bg-ink-950 px-1 py-0.5 text-center text-sm text-mist-100 outline-none focus:border-accent-500"
          />
          <span className="whitespace-nowrap text-mist-500">{t('pdf.of', { count: pages })}</span>
          <button type="button" className={button} onClick={() => go(current + 1)} disabled={!ready || current >= pages} aria-label={t('pdf.next')} title={t('pdf.next')}>
            <Symbol name="chevronDown" className="h-4 w-4" />
          </button>
        </div>
        {!compact && (
          <div className="flex shrink-0 items-center max-sm:hidden">
            <span className="mx-1 h-5 w-px bg-ink-700" />
            <button type="button" className={button} onClick={() => say({ type: 'zoom', to: 'out' })} disabled={!ready} aria-label={t('pdf.zoomOut')} title={t('pdf.zoomOut')}>
              <Symbol name="minus" className="h-4 w-4" />
            </button>
            <span className="w-11 text-center text-xs text-mist-400 tabular-nums">{percent ? `${percent} %` : ''}</span>
            <button type="button" className={button} onClick={() => say({ type: 'zoom', to: 'in' })} disabled={!ready} aria-label={t('pdf.zoomIn')} title={t('pdf.zoomIn')}>
              <Symbol name="plus" className="h-4 w-4" />
            </button>
            <button type="button" className={button} onClick={() => say({ type: 'zoom', to: 'width' })} disabled={!ready} aria-label={t('pdf.fit')} title={t('pdf.fit')}>
              <Symbol name="fit" className="h-4 w-4" />
            </button>
            <span className="mx-1 h-5 w-px bg-ink-700" />
          </div>
        )}
        {!compact && (
          <button type="button" className={button} onClick={() => (finding ? setFinding(false) : openFind())} aria-pressed={finding} disabled={!ready} aria-label={t('pdf.find')} title={t('pdf.find')}>
            <Symbol name="search" className="h-4 w-4" />
          </button>
        )}
        <button type="button" className={button} onClick={() => void copyPage()} disabled={!ready} aria-label={t('pdf.copyLink')} title={t('pdf.copyLink')}>
          <Symbol name={copied ? 'check' : 'link'} className="h-4 w-4" />
        </button>
        {compact && onOpenLarge && (
          <button type="button" className={button} onClick={() => onOpenLarge(current)} aria-label={t('pdf.openLarge')} title={t('pdf.openLarge')}>
            <Symbol name="open" className="h-4 w-4" />
          </button>
        )}
        {!compact && (
          <a href={fileUrl(path, true)} className={button} aria-label={t('file.download')} title={t('file.download')}>
            <Symbol name="download" className="h-4 w-4" />
          </a>
        )}
        {tools}
      </div>
      {copied && <p className="sr-only" role="status">{t('pdf.copied')}</p>}
      {finding && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-ink-800 bg-ink-900 px-3 py-1.5 text-sm">
          <Symbol name="search" className="h-4 w-4 text-mist-500" />
          <input
            ref={findField}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              if (event.target.value.trim()) say({ type: 'find', query: event.target.value.trim(), previous: false, again: false })
              else setFound({ current: 0, total: 0 })
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') find(event.shiftKey, true)
              if (event.key === 'Escape') setFinding(false)
            }}
            aria-label={t('pdf.find')}
            placeholder={t('pdf.findPlaceholder')}
            className="w-56 max-w-full rounded-md border border-ink-700 bg-ink-950 px-2 py-0.5 text-sm text-mist-100 outline-none focus:border-accent-500"
          />
          <span className="text-xs text-mist-500 tabular-nums" role="status" data-testid="pdf-found">
            {query.trim() ? t('pdf.found', { current: found.current, total: found.total }) : ''}
          </span>
          <button type="button" className={button} onClick={() => find(true, true)} aria-label={t('pdf.findPrevious')}>
            <Symbol name="chevronUp" className="h-4 w-4" />
          </button>
          <button type="button" className={button} onClick={() => find(false, true)} aria-label={t('pdf.findNext')}>
            <Symbol name="chevronDown" className="h-4 w-4" />
          </button>
          <span className="flex-1" />
          <button type="button" className={button} onClick={() => setFinding(false)} aria-label={t('common.close')}>
            <Symbol name="close" className="h-4 w-4" />
          </button>
        </div>
      )}
      <div className="relative min-h-0 flex-1 bg-ink-950">
        {failed === 'load' ? (
          <p className="p-6 text-center text-sm text-mist-500" role="alert">{t('pdf.loadFailed')}</p>
        ) : (
          <iframe
            ref={frame}
            key={path}
            src="/pdfview.html"
            sandbox="allow-scripts"
            title={t('pdf.frameTitle', { name })}
            className="absolute inset-0 h-full w-full border-0"
            data-testid="pdf-frame"
          />
        )}
      </div>
    </div>
  )
}
