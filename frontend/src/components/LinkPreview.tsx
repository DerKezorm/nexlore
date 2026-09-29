/**
 * Page preview, as Obsidian's core plugin: resting the mouse on a link to a note shows that note in a small window
 * beside it. In the reading view, the backlinks and the links of a note it opens after a moment; in the editor with
 * Ctrl or Cmd held (a plain hover there is for placing the cursor). The note comes from the server with the rights of
 * the reader, as when it is opened; a phone (no hover) has none of this.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { vaultApi } from '../api/client'
import { useEnrich } from '../lib/enrich'
import { appTargets, renderMarkdown } from '../lib/markdown'
import { shownNote } from '../lib/shell'
import { folderOf, noteUrl } from '../lib/vault'

const DELAY = 350
const GRACE = 250
const WIDTH = 440
const HEIGHT = 340

type Shown = { path: string; x: number; y: number; above: boolean }
type Loaded = { path: string; title: string; html: string } | 'loading' | 'failed'

const cache = new Map<string, { at: number; value: { title: string; html: string } }>()

async function loadNote(path: string): Promise<{ title: string; html: string }> {
  const kept = cache.get(path)
  if (kept && Date.now() - kept.at < 30_000) return kept.value
  const [note, links] = await Promise.all([vaultApi.note(path), vaultApi.links(path)])
  const map = new Map<string, string>()
  for (const link of links.outgoing) if (link.path) map.set(link.target.toLowerCase(), link.path)
  const html = renderMarkdown(note.content.slice(0, 6000), (target) => map.get(target.toLowerCase()) ?? null, path, appTargets(path, false))
  const value = { title: note.title, html }
  cache.set(path, { at: Date.now(), value })
  return value
}

/** Where a link leads: a note path from the reading view and the lists, or asked of the server for the editor. */
async function targetOf(element: Element): Promise<string | null> {
  const note = element.getAttribute('data-note')
  if (note) return note
  const written = element.getAttribute('data-target')
  const source = shownNote()?.path
  if (!written || !source) return null
  const found = await vaultApi.resolve(source, written, 'wiki').catch(() => null)
  return found?.path && found.is_note ? found.path : null
}

export function LinkPreview() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [shown, setShown] = useState<Shown | null>(null)
  const [loaded, setLoaded] = useState<Loaded>('loading')
  const box = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const timer = useRef(0)
  const closing = useRef(0)
  const over = useRef<Element | null>(null)
  useEnrich(body, typeof loaded === 'string' ? loaded : loaded.html)

  useEffect(() => {
    if (window.matchMedia?.('(hover: none)').matches) return
    const close = () => {
      window.clearTimeout(timer.current)
      setShown(null)
    }
    const open = async (element: Element) => {
      const path = await targetOf(element)
      if (!path || over.current !== element) return
      const rect = element.getBoundingClientRect()
      const above = rect.bottom + HEIGHT + 16 > window.innerHeight && rect.top > HEIGHT + 16
      const x = Math.max(8, Math.min(rect.left, window.innerWidth - WIDTH - 8))
      setShown({ path, x, y: above ? rect.top - 8 : rect.bottom + 8, above })
      setLoaded('loading')
      loadNote(path).then(
        (value) => setLoaded({ path, ...value }),
        () => setLoaded('failed'),
      )
    }
    const linkAt = (target: EventTarget | null, withKey: boolean): Element | null => {
      if (!(target instanceof Element) || box.current?.contains(target)) return null
      const reading = target.closest('[data-note]')
      if (reading) return reading
      return withKey ? target.closest('.nx-wiki[data-target]') : null
    }
    const onOver = (event: MouseEvent) => {
      if (box.current?.contains(event.target as Node)) {
        window.clearTimeout(closing.current)
        return
      }
      const link = linkAt(event.target, event.ctrlKey || event.metaKey)
      if (link === over.current) return
      over.current = link
      window.clearTimeout(timer.current)
      if (!link) {
        closing.current = window.setTimeout(close, GRACE)
        return
      }
      window.clearTimeout(closing.current)
      timer.current = window.setTimeout(() => void open(link), DELAY)
    }
    const onKey = (event: KeyboardEvent) => {
      // Ctrl pressed while resting on a link in the editor.
      if (event.key !== 'Control' && event.key !== 'Meta') return
      const hovered = document.querySelectorAll(':hover')
      const last = hovered[hovered.length - 1]
      const link = last ? linkAt(last, true) : null
      if (link && link !== over.current) {
        over.current = link
        void open(link)
      }
    }
    const onKeyEscape = (event: KeyboardEvent) => event.key === 'Escape' && close()
    // Scrolling what holds the link moves it away from its preview; scrolling elsewhere (the sidebar finding the open
    // note, the preview itself) does not.
    const onScroll = (event: Event) => {
      const moved = event.target instanceof Node ? event.target : document.documentElement
      if (box.current?.contains(moved)) return
      if (over.current && moved.contains(over.current)) close()
      else if (!over.current) setShown(null)
    }
    document.addEventListener('mouseover', onOver)
    document.addEventListener('keydown', onKey)
    document.addEventListener('keydown', onKeyEscape)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('keydown', onKeyEscape)
      window.removeEventListener('scroll', onScroll, true)
      window.clearTimeout(timer.current)
      window.clearTimeout(closing.current)
    }
  }, [])

  if (!shown) return null
  const go = (path: string) => {
    setShown(null)
    navigate(noteUrl(path))
  }
  return (
    <div
      ref={box}
      role="dialog"
      aria-label={t('preview.label')}
      data-testid="link-preview"
      className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl"
      style={{ left: shown.x, top: shown.above ? undefined : shown.y, bottom: shown.above ? window.innerHeight - shown.y : undefined, width: WIDTH, maxHeight: HEIGHT }}
      onMouseLeave={() => {
        over.current = null
        closing.current = window.setTimeout(() => setShown(null), GRACE)
      }}
    >
      <button type="button" onClick={() => go(shown.path)} className="flex items-baseline gap-2 border-b border-ink-700 px-4 py-2 text-left hover:bg-ink-850">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-mist-100">{typeof loaded === 'string' ? shown.path.split('/').pop()?.replace(/\.md$/i, '') : loaded.title}</span>
        <span className="max-w-[45%] shrink-0 truncate text-xs text-mist-600">{folderOf(shown.path).replace(/\//g, ' › ')}</span>
      </button>
      {typeof loaded === 'string' ? (
        <p className="px-4 py-3 text-sm text-mist-500">{loaded === 'loading' ? t('common.loading') : t('preview.failed')}</p>
      ) : (
        <div
          ref={body}
          className="nn-prose nn-scroll min-h-0 overflow-y-auto px-4 py-2 text-sm"
          onClick={(event) => {
            const link = (event.target as HTMLElement).closest('a[data-note]')
            if (link) {
              event.preventDefault()
              go(link.getAttribute('data-note')!)
            }
          }}
          dangerouslySetInnerHTML={{ __html: loaded.html }}
        />
      )}
    </div>
  )
}
