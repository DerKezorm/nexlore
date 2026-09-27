/** Markdown to HTML for the reading view, with [[wiki links]] turned into clickable links. */
import { Marked, type Token } from 'marked'

import { fileUrl } from '../api/client'
import i18n, { locale } from '../i18n'
import { fileKind, isNotePath, relativeTarget } from './files'

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

/** The page of a file that is not a note: preview, download, the notes that use it. */
export function fileRoute(path: string): string {
  return '/file/' + path.split('/').map(encodeURIComponent).join('/')
}

/**
 * Where links and pictures lead. In the app to the vault (`appTargets`); on a public page to what the share lets
 * out, and nowhere else (`PublicPage`).
 */
export type Targets = {
  /** Where a picture, a video or a sound is loaded from. */
  fileUrl: (path: string) => string
  /** Where a link to a file leads. */
  fileHref: (path: string) => string
  /** The attributes of a link to a note: `data-note` in the app (the page opens it), an address on a public page. */
  noteAttributes: (path: string) => string
  /** Where a relative Markdown link or picture points, as a path; null leaves it as written. */
  relative: (href: string) => string | null
  /** Where a Markdown link to a note leads; left out, the link stays as written (the note page handles it). */
  noteHref?: (path: string) => string
  /** A wiki link that leads nowhere: in the app a pale link that makes the note, on a public page plain text. */
  missing?: (text: string) => string
  /** A relative Markdown link that may not lead anywhere (out of a share): shown as its text. */
  closed?: (href: string) => boolean
}

/** Marks a Markdown link that is shown as its text; the mark never survives into the page. */
const PLAIN = '#nn-plain'

export function appTargets(notePath: string | null): Targets {
  return {
    fileUrl: (path) => fileUrl(path),
    fileHref: fileRoute,
    noteAttributes: (path) => `data-note="${escape(path)}"`,
    relative: (href) => (notePath ? relativeTarget(notePath, href) : null),
  }
}

function markdownFor(targets: Targets) {
  return new Marked({
    async: false,
    gfm: true,
    walkTokens(token: Token) {
      if (token.type !== 'link' && token.type !== 'image') return
      if (!safeUrl(token.href)) {
        token.href = '#'
        return
      }
      // A path in the vault: pictures come from the server, links to files lead to their page.
      if (token.type === 'link' && targets.closed?.(token.href)) {
        token.href = PLAIN
        return
      }
      const target = targets.relative(token.href)
      if (!target) return
      if (token.type === 'image') token.href = targets.fileUrl(target)
      else if (!isNotePath(target)) token.href = targets.fileHref(target)
      else if (targets.noteHref) token.href = targets.noteHref(target)
    },
  })
}

/** The front matter at the top of a note: shown as properties, not as text. */
export function withoutFrontMatter(body: string): string {
  const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(body)
  return match ? body.slice(match[0].length) : body
}

function fileLink(path: string, text: string, targets: Targets): string {
  return `<a class="nn-wikilink nn-filelink" data-file="${escape(path)}" href="${escape(targets.fileHref(path))}">${text}</a>`
}

/** An embedded file where the embed stands: a picture, a video, a sound, or a link to its page. */
function embedded(path: string, text: string, width: string, targets: Targets): string {
  const url = escape(targets.fileUrl(path))
  const size = width ? ` style="width:${Number(width)}px"` : ''
  switch (fileKind(path)) {
    case 'image':
      return `<img class="nn-embed" src="${url}" alt="${text}"${size}>`
    case 'video':
      return `<video class="nn-embed" src="${url}" controls preload="metadata"${size}></video>`
    case 'audio':
      return `<audio class="nn-embed" src="${url}" controls preload="metadata"></audio>`
    default:
      return fileLink(path, text, targets)
  }
}

/**
 * Markdown to HTML. `resolve` answers where a wiki link points (a vault path) or null; the server knows, because
 * it resolves links the way Obsidian does. `notePath`: the note shown, for its relative links and pictures.
 */
export function renderMarkdown(
  body: string,
  resolve: (target: string) => string | null,
  notePath: string | null = null,
  targets: Targets = appTargets(notePath),
): string {
  // Raw HTML in a note is shown as text, not executed: notes can come from other people and from an AI.
  const safe = withoutFrontMatter(body).replace(/</g, '&lt;')
  const linked = safe.replace(/(!?)\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, embed: string, target: string, label?: string) => {
    const path = target.trim() ? resolve(target.trim()) : null
    // An embed's `|300` is its width, not a caption.
    const width = embed && label && /^\d+(x\d+)?$/.test(label.trim()) ? label.trim().split('x')[0] : ''
    const text = escape((width ? target : (label ?? target)).trim())
    if (path && !isNotePath(path)) return embed ? embedded(path, text, width, targets) : fileLink(path, text, targets)
    return path
      ? `<a class="nn-wikilink" ${targets.noteAttributes(path)}>${text}</a>`
      : targets.missing
        ? targets.missing(text)
        : `<a class="nn-wikilink nn-wikilink-missing" title="${escape(i18n.t('note.missingLink'))}">${text}</a>`
  })
  const html = markdownFor(targets).parse(linked) as string
  return html.replace(/<a href="#nn-plain"[^>]*>([\s\S]*?)<\/a>/g, '$1')
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

/** A day, as a date: for end dates, which lie ahead (`formatDate` speaks of the past). */
export function formatDay(when: string | number): string {
  return new Date(when).toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric' })
}
