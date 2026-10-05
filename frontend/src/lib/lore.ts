/**
 * Frag Lore in the browser (`routers/lore.py`): the question goes out, the answer comes back as a stream of events,
 * read here line by line. The answer is Markdown; it is drawn by the reading view's renderer (no HTML from the
 * model gets in), its `[n]` become the numbered chips that point at the sources, and a last line `!missing: …`
 * becomes the box that says what the notes do not say.
 */
import { ApiError, tabId, type LoreAsk, type LoreEvent, type LoreSource } from '../api/client'
import { renderMarkdown } from './markdown'
import { noteUrl } from './vault'

/** Lore left a proposal on a note (`detail`: its path): the note page shows it without being opened again. */
export const PROPOSALS_EVENT = 'nexlore:lore-proposed'

/** The events whole in `buffer`, and what is left of an event still coming. */
export function splitEvents(buffer: string): { events: LoreEvent[]; rest: string } {
  const events: LoreEvent[] = []
  const blocks = buffer.replace(/\r\n/g, '\n').split('\n\n')
  const rest = blocks.pop() ?? ''
  for (const block of blocks) {
    let name = ''
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) name = line.slice(7).trim()
      else if (line.startsWith('data: ')) data += line.slice(6)
    }
    if (!name || !data) continue
    try {
      events.push({ name, data: JSON.parse(data) } as LoreEvent)
    } catch {
      // A broken line is skipped; the next one may be whole.
    }
  }
  return { events, rest }
}

/** Asks and hands every event to `heard` as it comes. Refused before the answer starts, it throws like any call. */
export async function askLore(body: LoreAsk, heard: (event: LoreEvent) => void, signal?: AbortSignal): Promise<void> {
  const response = await fetch('/api/lore/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-Nexlore-Client': tabId() },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => null)
    const detail = data?.detail
    if (detail && typeof detail === 'object' && typeof detail.code === 'string') {
      const { code, message: _message, ...values } = detail
      throw new ApiError(response.status, code, values)
    }
    throw new ApiError(response.status, response.status === 401 ? 'sign_in_required' : 'internal_error')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
    const { events, rest } = splitEvents(buffer)
    buffer = rest
    events.forEach(heard)
    if (done) break
  }
}

const MISSING = /^\s*!missing:\s*(.*)$/i

/** The answer without its `!missing:` lines, and what they say. */
export function answerParts(text: string): { body: string; missing: string[] } {
  const missing: string[] = []
  const kept: string[] = []
  for (const line of text.split('\n')) {
    const found = MISSING.exec(line)
    if (found) {
      if (found[1].trim()) missing.push(found[1].trim())
    } else kept.push(line)
  }
  return { body: kept.join('\n').trim(), missing }
}

/** The answer as HTML for the reading view: wiki links to a source lead there, `[n]` of a source is its chip. */
export function answerHtml(text: string, sources: LoreSource[]): string {
  const byTitle = new Map(sources.map((source) => [source.title.toLocaleLowerCase(), source.path]))
  // The same source twice in a row ("[3] [3]", "[3][3]") is said once.
  text = text.replace(/\[(\d{1,2})\](?:\s*\[\1\])+/g, '[$1]')
  const html = renderMarkdown(text, (target) => byTitle.get(target.split('#')[0].split('/').pop()!.toLocaleLowerCase()) ?? null)
  const known = new Set(sources.map((source) => source.n))
  // Only in text, never inside a tag or in code; only numbers that are there.
  return html
    .split(/(<code[\s\S]*?<\/code>)/)
    .map((part) =>
      part.startsWith('<code')
        ? part
        : part.replace(/\[(\d{1,2})\](?![^<]*>)/g, (whole, digits: string) =>
            known.has(Number(digits)) ? `<sup><button type="button" class="nl-src" data-source="${digits}">${digits}</button></sup>` : whole,
          ),
    )
    .join('')
}

/** The way a source is opened: the note, at its heading. */
export function sourceUrl(source: Pick<LoreSource, 'path' | 'heading'> & { title?: string }): string {
  // The section under the note's own first heading is the note: no jump.
  const heading = source.heading && source.heading !== source.title ? source.heading : ''
  return noteUrl(source.path) + (heading ? `#${encodeURIComponent(heading)}` : '')
}
