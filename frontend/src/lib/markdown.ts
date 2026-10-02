/**
 * Markdown to HTML for the reading view, with Obsidian's own writing: [[wiki links]] and embeds, callouts,
 * `%%comments%%` and `==highlights==`, formulas (`$…$`, `$$…$$`), footnotes (`[^1]`, `^[inline]`) and Mermaid
 * diagrams. Each is a marked extension, so none of it applies inside code. Formulas, diagrams and the colours of
 * code are only marked here; `lib/enrich.ts` draws them after the page shows (their libraries load only then).
 */
import { Marked, type Token, type TokenizerAndRendererExtension, type Tokens } from 'marked'

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
  /**
   * The attributes of a link to a note: `data-note` in the app (the page opens it), an address on a public page.
   * `section`: the heading or block after `#` (`[[Note#Heading]]`); in the app the page scrolls to it.
   */
  noteAttributes: (path: string, section?: string) => string
  /** The note itself, for `[[#Heading]]`: a link to a part of the same note. Left out, such a link leads nowhere. */
  self?: string
  /** Where a relative Markdown link or picture points, as a path; null leaves it as written. */
  relative: (href: string) => string | null
  /** Where a Markdown link to a note leads; left out, the link stays as written (the note page handles it). */
  noteHref?: (path: string) => string
  /** A wiki link that leads nowhere: in the app a pale link that makes the note, on a public page plain text. */
  missing?: (text: string) => string
  /** A relative Markdown link that may not lead anywhere (out of a share): shown as its text. */
  closed?: (href: string) => boolean
  /**
   * An embedded note (`![[Note]]`, `![[Note#Heading]]`): in the app a holder the note page fills (`NoteEmbeds`).
   * Left out (public pages, and inside an embedded note: one level deep), the embed is a link to the note.
   */
  embedNote?: (path: string, section: string, text: string) => string
}

/** Marks a Markdown link that is shown as its text; the mark never survives into the page. */
const PLAIN = '#nn-plain'

/** `Anh%C3%A4nge/foto.png` as the index keeps it, `Anhänge/foto.png`; as written when it does not decode. */
function decoded(href: string): string {
  try {
    return decodeURIComponent(href)
  } catch {
    return href
  }
}

/** `embeds`: whether notes embedded in this one are shown; false inside an embed, so it goes one level deep. */
export function appTargets(notePath: string | null, embeds = true): Targets {
  const noteAttributes = (path: string, section = '') =>
    `data-note="${escape(path)}"` + (section ? ` data-section="${escape(section)}"` : '')
  return {
    fileUrl: (path) => fileUrl(path),
    fileHref: fileRoute,
    noteAttributes,
    self: notePath ?? undefined,
    relative: (href) => (notePath ? relativeTarget(notePath, href) : null),
    // The link stays inside as long as nothing is filled in (too many embeds, or no page to fill them).
    embedNote: embeds
      ? (path, section, text) =>
          `<span class="nn-embed-note" data-embed="${escape(path)}" data-section="${escape(section)}"><a class="nn-wikilink" ${noteAttributes(path, section)}>${text}</a></span>`
      : undefined,
  }
}

/** Where a heading or a block of a note begins and ends, as lines; code blocks are not looked into. */
export function noteSection(body: string, section: string): string | null {
  const lines = withoutFrontMatter(body).split(/\r?\n/)
  const fold = (text: string) => text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()
  let fence: string | null = null
  const outside = lines.map((line) => {
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence === null && mark) {
      fence = mark
      return false
    }
    if (fence !== null) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length && !line.trim().slice(mark.length)) fence = null
      return false
    }
    return true
  })
  const heading = (index: number) => (outside[index] ? /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(lines[index]) : null)
  if (section.startsWith('^')) {
    // A block: the line that ends in `^id`; a paragraph around it, a list item alone. The mark itself is left out.
    const id = section.slice(1).trim()
    const end = new RegExp(`(?:^|\\s)\\^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \t]*$`)
    const at = lines.findIndex((line, index) => outside[index] && end.test(line))
    if (!id || at < 0) return null
    // The mark stands at the end of its block: a paragraph reaches up from it.
    let first = at
    if (!/^\s*(?:[-*+]|\d+[.)])\s/.test(lines[at])) {
      while (first > 0 && lines[first - 1].trim() && !heading(first - 1)) first -= 1
    }
    return lines.slice(first, at + 1).join('\n').replace(end, '')
  }
  // A heading; `Note#Part#Subpart` means the subpart.
  const wanted = fold(section.split('#').pop() ?? '')
  const start = lines.findIndex((_, index) => fold(heading(index)?.[2] ?? '\u0000') === wanted)
  if (!wanted || start < 0) return null
  const level = heading(start)![1].length
  let stop = start + 1
  while (stop < lines.length && !((heading(stop)?.[1].length ?? 7) <= level)) stop += 1
  return lines.slice(start, stop).join('\n')
}

/** `Target#Part|Shown` into its three parts; a table cell writes the bar as `\|`. */
function wikiParts(inner: string): { target: string; section: string; label?: string } {
  const bar = /\\?\|/.exec(inner)
  const pathPart = bar ? inner.slice(0, bar.index) : inner
  const hash = pathPart.indexOf('#')
  return {
    target: (hash < 0 ? pathPart : pathPart.slice(0, hash)).trim(),
    section: hash < 0 ? '' : pathPart.slice(hash + 1).trim(),
    label: bar ? inner.slice(bar.index + bar[0].length) : undefined,
  }
}

/** Obsidian's callout types that share a colour; anything else looks like a note. */
const CALLOUT_KIND = /^[a-z0-9-]{1,40}$/

function wikiLink(embed: boolean, inner: string, resolve: (target: string) => string | null, targets: Targets): string {
  const { target, section, label } = wikiParts(inner)
  // `[[#Heading]]` leads to a part of the same note.
  const path = target ? resolve(target) : section && !embed ? (targets.self ?? null) : null
  // An embed's `|300` is its width, not a caption.
  const width = embed && label && /^\d+(x\d+)?$/.test(label.trim()) ? label.trim().split('x')[0] : ''
  // Without a label, a link to a heading or block names it too (`Note › Heading`), as the editor shows it; a part of
  // the same note only by its own name.
  const part = section.replace(/^\^/, '')
  const shown = section && !embed ? (target ? `${target} › ${part}` : part) : target
  const text = escape((width || label === undefined ? shown : label).trim() || target)
  if (path && !isNotePath(path)) return embed ? embedded(path, text, width, targets) : fileLink(path, text, targets)
  if (path && embed && targets.embedNote) return targets.embedNote(path, section, text)
  return path
    ? `<a class="nn-wikilink" ${targets.noteAttributes(path, section)}>${text}</a>`
    : targets.missing
      ? targets.missing(text)
      : `<a class="nn-wikilink nn-wikilink-missing" data-missing="${escape(section ? `${target}#${section}` : target)}" title="${escape(i18n.t('note.missingLink'))}">${text}</a>`
}

/** The extensions for Obsidian's own writing. A new set for each note, because wiki links need its `resolve`. */
function obsidian(resolve: (target: string) => string | null, targets: Targets): TokenizerAndRendererExtension[] {
  const WIKI = /^(!?)\[\[([^[\]\r\n]+?)\]\]/
  return [
    {
      // `%% … %%` on lines of its own, over as many lines as it takes: nothing of it is shown.
      name: 'commentBlock',
      level: 'block',
      start: (src) => /^ {0,3}%%/m.exec(src)?.index,
      tokenizer(src) {
        const found = /^ {0,3}%%(?:(?!%%)[\s\S])*%%[ \t]*(?:\n+|$)/.exec(src)
        if (found) return { type: 'commentBlock', raw: found[0] }
      },
      renderer: () => '',
    },
    {
      // A note embedded on a line of its own is a block, not a paragraph (the note it shows has paragraphs).
      name: 'embedBlock',
      level: 'block',
      tokenizer(src) {
        const found = /^ {0,3}!\[\[([^[\]\r\n]+?)\]\][ \t]*(?:\n+|$)/.exec(src)
        if (!found || !targets.embedNote) return
        const path = resolve(wikiParts(found[1]).target)
        if (path && isNotePath(path)) return { type: 'embedBlock', raw: found[0], inner: found[1] }
      },
      renderer: (token) => `<div class="nn-embed-block">${wikiLink(true, token.inner as string, resolve, targets)}</div>\n`,
    },
    {
      // `> [!type]± Title` and the quote below it; `-` folds it shut, `+` open. Callouts may hold callouts.
      name: 'callout',
      level: 'block',
      start: (src) => /^ {0,3}>/m.exec(src)?.index,
      tokenizer(src) {
        const found = /^ {0,3}>[ \t]?\[!([^\]\r\n]+)\]([+-]?)[ \t]*([^\n]*)(?:\n|$)((?: {0,3}>[^\n]*(?:\n|$))*)/.exec(src)
        if (!found) return
        const kind = found[1].trim().toLowerCase()
        const body = found[4].replace(/^ {0,3}> ?/gm, '')
        return {
          type: 'callout',
          raw: found[0],
          kind: CALLOUT_KIND.test(kind) ? kind : 'note',
          fold: found[2],
          title: this.lexer.inlineTokens(found[3].trim() || kind.charAt(0).toUpperCase() + kind.slice(1)),
          tokens: this.lexer.blockTokens(body),
        }
      },
      renderer(token) {
        const title = this.parser.parseInline(token.title as Token[])
        const body = `<div class="nn-callout-content">${this.parser.parse(token.tokens ?? [])}</div>`
        const kind = token.kind as string
        const attributes = `class="nn-callout nn-callout-${kind}" data-callout="${kind}"`
        return token.fold
          ? `<details ${attributes}${token.fold === '+' ? ' open' : ''}><summary class="nn-callout-title">${title}</summary>${body}</details>\n`
          : `<div ${attributes}><div class="nn-callout-title">${title}</div>${body}</div>\n`
      },
      childTokens: ['title', 'tokens'],
    },
    {
      // A Templater command (`<% tp.date.now() %>`) is shown as the code it is; it never runs here.
      name: 'templater',
      level: 'inline',
      start: (src) => src.match(/<%/)?.index,
      tokenizer(src) {
        const found = /^<%[\s\S]*?%>/.exec(src)
        if (found) return { type: 'templater', raw: found[0] }
      },
      renderer: (token) => `<code class="nn-templater">${escape(token.raw)}</code>`,
    },
    {
      // ` ^id` at the end of a line marks a block for `[[Note#^id]]`: an anchor there, nothing to read.
      name: 'blockId',
      level: 'inline',
      start: (src) => / \^[A-Za-z0-9-]+(?=\n|$)/.exec(src)?.index,
      tokenizer(src) {
        const found = /^ \^([A-Za-z0-9-]+)(?=\n|$)/.exec(src)
        if (found) return { type: 'blockId', raw: found[0], id: found[1] }
      },
      renderer: (token) => `<span class="nn-block-id" id="^${escape(token.id as string)}"></span>`,
    },
    {
      name: 'comment',
      level: 'inline',
      start: (src) => src.match(/%%/)?.index,
      tokenizer(src) {
        const found = /^%%[\s\S]*?%%/.exec(src)
        if (found) return { type: 'comment', raw: found[0] }
      },
      renderer: () => '',
    },
    {
      name: 'wiki',
      level: 'inline',
      start: (src) => src.match(/!?\[\[/)?.index,
      tokenizer(src) {
        const found = WIKI.exec(src)
        if (found) return { type: 'wiki', raw: found[0], embed: found[1] === '!', inner: found[2] }
      },
      renderer: (token) => wikiLink(token.embed as boolean, token.inner as string, resolve, targets),
    },
    {
      // `#tag` after a blank or at the start of a line, as the server reads tags (not only digits, `/` nests).
      name: 'tag',
      level: 'inline',
      start(src) {
        const found = /(^|\s)#[\p{L}\p{N}_/-]/u.exec(src)
        return found ? found.index + found[1].length : undefined
      },
      tokenizer(src) {
        const found = /^#([\p{L}\p{N}_/-]+)/u.exec(src)
        const tag = found?.[1].replace(/\/+$/, '')
        if (tag && !/^[\d/]+$/.test(tag)) return { type: 'tag', raw: '#' + tag, tag }
      },
      renderer: (token) => `<span class="nn-tag" data-tag="${escape(token.tag as string)}">#${escape(token.tag as string)}</span>`,
    },
    {
      name: 'highlight',
      level: 'inline',
      start: (src) => src.match(/==/)?.index,
      tokenizer(src) {
        const found = /^==(?=[^\s=])([\s\S]*?[^\s=])==(?!=)/.exec(src)
        if (found) return { type: 'highlight', raw: found[0], tokens: this.lexer.inlineTokens(found[1]) }
      },
      renderer(token) {
        return `<mark>${this.parser.parseInline(token.tokens ?? [])}</mark>`
      },
    },
  ]
}

/** Each rendering numbers its footnotes; the id keeps two notes on one page (an embed, two panes) apart. */
let renders = 0

/** The footnotes of one rendering: definitions found while reading, numbers given as the references are drawn. */
class Footnotes {
  readonly id = `fn${++renders}`
  /** The text of each definition, by its folded name, in the order they stand. */
  readonly defs = new Map<string, { name: string; text: string }>()
  /** The notes in the order of their first reference: a named one, or an inline one with its text drawn already. */
  readonly shown: { key: string | null; html: string | null; refs: number }[] = []

  reference(name: string): { number: number; ref: string } | null {
    const key = name.toLocaleLowerCase()
    if (!this.defs.has(key)) return null
    let at = this.shown.findIndex((note) => note.key === key)
    if (at < 0) at = this.shown.push({ key, html: null, refs: 0 }) - 1
    const note = this.shown[at]
    note.refs += 1
    return { number: at + 1, ref: `${this.id}-ref-${at + 1}${note.refs > 1 ? '-' + note.refs : ''}` }
  }

  inline(html: string): { number: number; ref: string } {
    const number = this.shown.push({ key: null, html, refs: 1 })
    return { number, ref: `${this.id}-ref-${number}` }
  }

  /** The list at the end: referenced ones by number, then definitions nothing refers to. */
  section(parse: (text: string) => string): string {
    const listed = new Set(this.shown.map((note) => note.key))
    const rest = [...this.defs.keys()].filter((key) => !listed.has(key)).map((key) => ({ key, html: null, refs: 0 }))
    const all = [...this.shown, ...rest]
    if (all.length === 0) return ''
    const items = all.map((note, index) => {
      const number = index + 1
      const html = note.html ?? parse(this.defs.get(note.key!)!.text)
      const back = note.refs
        ? ` <a class="nn-fn-back" href="#${this.id}-ref-${number}" aria-label="${escape(i18n.t('note.footnoteBack'))}">↩</a>`
        : ''
      return `<li id="${this.id}-${number}">${html}${back}</li>`
    })
    return `<section class="nn-footnotes" role="doc-endnotes"><ol>${items.join('')}</ol></section>`
  }
}

/** Formulas and footnotes: marked extensions like Obsidian's own writing above. */
function extras(notes: Footnotes): TokenizerAndRendererExtension[] {
  return [
    {
      // $$ … $$ as a block of its own, over as many lines as it takes.
      name: 'mathBlock',
      level: 'block',
      start: (src) => /^ {0,3}\$\$/m.exec(src)?.index,
      tokenizer(src) {
        const found = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n+|$)/.exec(src)
        if (found) return { type: 'mathBlock', raw: found[0], text: found[1].trim() }
      },
      renderer: (token) => `<div class="nn-math" data-display="true">${escape(token.text)}</div>`,
    },
    {
      // $…$ in the text as Obsidian reads it: no blank right inside the dollars, no digit right after the closing one
      // ("costs 5$ and 10$" stays text). $$…$$ within a line is a formula shown on a line of its own.
      name: 'mathInline',
      level: 'inline',
      start: (src) => src.match(/\$/)?.index,
      tokenizer(src) {
        const display = /^\$\$([^\n]+?)\$\$/.exec(src)
        if (display) return { type: 'mathInline', raw: display[0], text: display[1].trim(), display: true }
        const found = /^\$(?![\s$])((?:\\\$|[^$\n])*?[^\s\\])\$(?!\d)/.exec(src) ?? /^\$([^\s$\\])\$(?!\d)/.exec(src)
        if (found) return { type: 'mathInline', raw: found[0], text: found[1], display: false }
      },
      renderer: (token) => `<span class="nn-math"${token.display ? ' data-display="true"' : ''}>${escape(token.text)}</span>`,
    },
    {
      // [^name]: text, continued by indented lines. Read before marked takes it for a link definition.
      name: 'footnoteDef',
      level: 'block',
      start: (src) => /^\[\^[^\]\s]+\]:/m.exec(src)?.index,
      tokenizer(src) {
        const found = /^\[\^([^\]\s]+)\]:[ \t]?([^\n]*(?:\n(?: {2,}|\t)[^\n]*)*)(?:\n+|$)/.exec(src)
        if (!found) return
        const key = found[1].toLocaleLowerCase()
        if (!notes.defs.has(key)) notes.defs.set(key, { name: found[1], text: found[2].replace(/\n(?: {2,}|\t)/g, ' ').trim() })
        return { type: 'footnoteDef', raw: found[0] }
      },
      renderer: () => '',
    },
    {
      name: 'footnoteRef',
      level: 'inline',
      start: (src) => src.match(/\[\^/)?.index,
      tokenizer(src) {
        const found = /^\[\^([^\]\s]+)\]/.exec(src)
        if (found) return { type: 'footnoteRef', raw: found[0], name: found[1] }
      },
      renderer(token) {
        const given = notes.reference(token.name)
        if (!given) return escape(token.raw)
        return `<sup class="nn-fn-ref" id="${given.ref}"><a href="#${notes.id}-${given.number}">${given.number}</a></sup>`
      },
    },
    {
      // ^[text right here]: numbered with the others, its text in the list at the end.
      name: 'footnoteInline',
      level: 'inline',
      start: (src) => src.match(/\^\[/)?.index,
      tokenizer(src) {
        const found = /^\^\[([^\]\n]+)\]/.exec(src)
        if (found) return { type: 'footnoteInline', raw: found[0], tokens: this.lexer.inlineTokens(found[1]) }
      },
      renderer(token) {
        const given = notes.inline(this.parser.parseInline(token.tokens ?? []))
        return `<sup class="nn-fn-ref" id="${given.ref}"><a href="#${notes.id}-${given.number}">${given.number}</a></sup>`
      },
    },
  ]
}

function markdownFor(resolve: (target: string) => string | null, targets: Targets) {
  const notes = new Footnotes()
  const marked = new Marked({
    async: false,
    gfm: true,
    // A single line break stays a line break, as Obsidian shows it with "strict line breaks" off (its default).
    breaks: true,
    // Raw HTML in a note is shown as text, not executed: notes can come from other people and from an AI.
    renderer: {
      html: ({ text }: Tokens.HTML | Tokens.Tag) => escape(text),
      // A Mermaid diagram is drawn after the page shows (lib/enrich.ts); until then, and if it cannot be, its text.
      code: ({ text, lang }: Tokens.Code) => {
        const language = lang?.trim().split(/\s/)[0].toLowerCase()
        if (language === 'mermaid') return `<div class="nn-mermaid">${escape(text)}</div>`
        // A view over notes (Obsidian's Bases) inside the app; elsewhere its YAML as code.
        if (language === 'base' && targets.embedNote) return `<div class="nn-base" data-base="${escape(text)}"></div>`
        return false
      },
    },
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
      // The picture the index found: next to the note, or else from the space's top, as Obsidian reads the path.
      if (token.type === 'image') token.href = targets.fileUrl(resolve(token.href) ?? resolve(decoded(token.href)) ?? target)
      else if (!isNotePath(target)) token.href = targets.fileHref(target)
      else if (targets.noteHref) token.href = targets.noteHref(target)
    },
  })
  marked.use({ extensions: [...obsidian(resolve, targets), ...extras(notes)] })
  return { marked, notes }
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
  const { marked, notes } = markdownFor(resolve, targets)
  const html = (marked.parse(withoutFrontMatter(body)) as string) + notes.section((text) => marked.parseInline(text) as string)
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

/** A date of the front matter as the app's language writes it; the file keeps what it says (2026-09-19). */
export function shownDate(raw: string, withTime: boolean, language: string): string {
  const found = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(raw)
  if (!found) return raw
  const [, year, month, day, hour, minute] = found
  const when = new Date(Number(year), Number(month) - 1, Number(day), Number(hour ?? 0), Number(minute ?? 0))
  if (Number.isNaN(when.getTime()) || when.getMonth() !== Number(month) - 1) return raw
  return when.toLocaleString(language, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' })
}
