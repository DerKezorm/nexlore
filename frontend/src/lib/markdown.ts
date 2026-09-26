/** Markdown to HTML for the reading view, with [[wiki links]] turned into clickable links. */
import { Marked, type Token } from 'marked'

import i18n, { locale } from '../i18n'

function escape(text: string | undefined): string {
  // An i18n text is undefined until the languages are loaded (in tests, for example).
  return (text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
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

/** The front matter at the top of a note: shown as properties, not as text. */
export function withoutFrontMatter(body: string): string {
  const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(body)
  return match ? body.slice(match[0].length) : body
}

/**
 * Markdown to HTML. `resolve` answers where a wiki link points (a vault path) or null; the server knows, because
 * it resolves links the way Obsidian does.
 */
export function renderMarkdown(body: string, resolve: (target: string) => string | null): string {
  // Raw HTML in a note is shown as text, not executed: notes can come from other people and from an AI.
  const safe = withoutFrontMatter(body).replace(/</g, '&lt;')
  const linked = safe.replace(/(!?)\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, _embed: string, target: string, label?: string) => {
    const path = target.trim() ? resolve(target.trim()) : null
    const text = escape((label ?? target).trim())
    return path
      ? `<a class="nn-wikilink" data-note="${escape(path)}">${text}</a>`
      : `<a class="nn-wikilink nn-wikilink-missing" title="${escape(i18n.t('note.missingLink'))}">${text}</a>`
  })
  return markdown.parse(linked) as string
}

export function formatDate(when: string | number): string {
  const date = new Date(when)
  const now = new Date()
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  const days = Math.floor((today - Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000)
  if (days <= 0) return i18n.t('time.today', { time: date.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) })
  if (days === 1) return i18n.t('time.yesterday')
  if (days < 7) return i18n.t('time.daysAgo', { count: days })
  return date.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric' })
}
