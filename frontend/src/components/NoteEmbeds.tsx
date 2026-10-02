/**
 * Notes embedded in the reading view (`![[Note]]`, `![[Note#Heading]]`, `![[Note#^block]]`). `renderMarkdown` leaves a
 * holder with a plain link in it; each holder is filled here with the note, or the part of it, rendered once more.
 * One level deep, like the links a reader can follow: an embed inside an embed stays a link. The server answers for
 * each embedded note with the reader's own rights, so nothing is shown that the link itself would not open.
 */
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react'
import { useEnrich } from '../lib/enrich'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { vaultApi } from '../api/client'
import { appTargets, noteSection, renderMarkdown } from '../lib/markdown'
import { baseName } from '../lib/vault'
import { Symbol } from './Symbol'

/** More embeds than this in one note stay links: each costs two requests. */
export const MAX_EMBEDS = 20

type Holder = { holder: HTMLElement; path: string; section: string; key: string }

export function NoteEmbeds({ article, html, onOpen }: { article: RefObject<HTMLElement | null>; html: string; onOpen: (path: string, section?: string) => void }) {
  const [holders, setHolders] = useState<Holder[]>([])
  useLayoutEffect(() => {
    const found: Holder[] = []
    article.current?.querySelectorAll<HTMLElement>('.nn-embed-note[data-embed]').forEach((holder, index) => {
      if (index >= MAX_EMBEDS) return
      holder.replaceChildren()
      found.push({ holder, path: holder.dataset.embed!, section: holder.dataset.section ?? '', key: `${index}-${holder.dataset.embed}` })
    })
    setHolders(found)
  }, [article, html])
  return <>{holders.map((item) => createPortal(<EmbeddedNote path={item.path} section={item.section} onOpen={onOpen} />, item.holder, item.key))}</>
}

type State = { html: string } | 'loading' | 'missing' | 'no-section'

function EmbeddedNote({ path, section, onOpen }: { path: string; section: string; onOpen: (path: string, section?: string) => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [state, setState] = useState<State>('loading')
  const body = useRef<HTMLSpanElement>(null)
  useEnrich(body, typeof state === 'string' ? state : state.html)

  useEffect(() => {
    // An answer for a note no longer shown (the page moved on) is dropped.
    let current = true
    setState('loading')
    Promise.all([vaultApi.note(path), vaultApi.links(path)])
      .then(([note, links]) => {
        if (!current) return
        const text = section ? noteSection(note.content, section) : note.content
        if (text === null) {
          setState('no-section')
          return
        }
        const map = new Map<string, string>()
        for (const link of links.outgoing) if (link.path) map.set(link.target.toLowerCase(), link.path)
        const resolve = (target: string) => map.get(target.toLowerCase()) ?? null
        setState({ html: renderMarkdown(text, resolve, path, appTargets(path, false)) })
      })
      .catch(() => {
        if (current) setState('missing')
      })
    return () => {
      current = false
    }
  }, [path, section])

  // Clicks inside a portal do not reach the article's own handler (React follows its tree, not the page's).
  const follow = (e: MouseEvent) => {
    const note = (e.target as HTMLElement).closest('a[data-note]')
    if (note) {
      e.preventDefault()
      onOpen(note.getAttribute('data-note')!, note.getAttribute('data-section') ?? '')
      return
    }
    const file = (e.target as HTMLElement).closest('a[data-file], a[href^="/file/"]')
    if (file && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      navigate(file.getAttribute('href')!)
    }
  }

  const title = baseName(path).replace(/\.md$/i, '') + (section ? ` › ${section.replace(/^\^/, '')}` : '')
  return (
    <span className="nn-embedded" data-state={typeof state === 'string' ? state : 'shown'}>
      <button type="button" className="nn-embedded-title" onClick={() => onOpen(path, section)}>
        <Symbol name="note" className="h-3.5 w-3.5" /> {title}
      </button>
      {state === 'loading' && <span className="nn-embedded-note">{t('note.embedLoading')}</span>}
      {state === 'missing' && <span className="nn-embedded-note">{t('note.embedMissing')}</span>}
      {state === 'no-section' && <span className="nn-embedded-note">{t('note.embedNoSection', { section })}</span>}
      {typeof state !== 'string' && <span ref={body} className="nn-embedded-body" onClick={follow} dangerouslySetInnerHTML={{ __html: state.html }} />}
    </span>
  )
}
