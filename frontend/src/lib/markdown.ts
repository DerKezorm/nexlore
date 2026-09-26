/** Markdown to HTML for the reading view, with [[wiki links]] turned into clickable links. */
import { Marked, type Token } from 'marked'

import i18n, { locale } from '../i18n'
import type { Vault } from './vault'

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/**
 * Where a link or an image in a note may point: the web, mail, or a path in the vault. `javascript:` and `data:`
 * would run code or show a forged page in nexlore's own origin; the Content Security Policy is a second wall, not
 * the only one. Blanks and control characters are removed first, because browsers ignore them in `java\tscript:`.
 */
export function safeUrl(href: string): boolean {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what has to go
  const compact = href.replace(/[\u0000- \u007f]/g, '')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact)
  return !scheme || ['http', 'https', 'mailto'].includes(scheme[1].toLowerCase())
}

const markdown = new Marked({
  async: false,
  gfm: true,
  walkTokens(token: Token) {
    if ((token.type === 'link' || token.type === 'image') && !safeUrl(token.href)) token.href = '#'
  },
})

export function renderMarkdown(body: string, vault: Vault): string {
  // Raw HTML in a note is shown as text, not executed: notes can come from other people and from an AI.
  const safe = body.replace(/</g, '&lt;')
  const linked = safe.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, title: string, label?: string) => {
    const target = vault.byTitle.get(title.trim().toLowerCase())
    const text = escape((label ?? title).trim())
    return target
      ? `<a class="nn-wikilink" data-note="${escape(target.id)}">${text}</a>`
      : `<a class="nn-wikilink nn-wikilink-missing" title="${escape(i18n.t('note.missingLink'))}">${text}</a>`
  })
  return markdown.parse(linked) as string
}

/** A few words around the first link to `title`, for the backlink list. */
export function snippetAround(body: string, title: string): string {
  const lower = body.toLowerCase()
  const index = lower.indexOf('[[' + title.toLowerCase())
  if (index < 0) return ''
  const start = Math.max(0, body.lastIndexOf('\n', index) + 1)
  let end = body.indexOf('\n', index)
  if (end < 0) end = body.length
  const line = body
    .slice(start, end)
    .replace(/^[-*#>\d.\s]+/, '')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, t: string, l?: string) => (l ?? t).trim())
    .replace(/\*\*/g, '')
    .trim()
  // A bare list entry under "Verwandt" says nothing beyond the title.
  return line.toLowerCase() === title.toLowerCase() ? '' : line
}

export function formatDate(iso: string): string {
  const date = new Date(iso)
  const today = new Date(Date.UTC(2026, 8, 26))
  const days = Math.floor((today.getTime() - Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())) / 86400000)
  if (days <= 0) return i18n.t('time.today', { time: date.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) })
  if (days === 1) return i18n.t('time.yesterday')
  if (days < 7) return i18n.t('time.daysAgo', { count: days })
  return date.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric' })
}
