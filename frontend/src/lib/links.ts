/**
 * Wiki links in the editor, answered by the server (Obsidian's rules live there, `index.resolve`): where a link
 * leads decides its colour while typing, and what `[[` suggests comes from `/api/notes/find`.
 *
 * The editor asks synchronously, many times a second, so answers are kept here. A link not asked about yet counts as
 * there (no red flicker while typing), is asked for together with the others that came up in the same moment, and
 * the editor is told to draw again when the answers are in (`changed`). The links the note had when it was saved come
 * with the note (`seed`), so an opened note shows its missing links at once.
 */
import type { Found, Outgoing } from '../api/client'
import { vaultApi } from '../api/client'
import type { Suggestion } from '../editor/suggest'
import { isFileTarget } from './files'

/** How a wiki link target is looked up: the note part, without heading, block or alias. */
export function linkName(target: string): string {
  return target.split('|', 1)[0].split('#', 1)[0].trim()
}

const fold = (text: string) => text.normalize('NFC').toLocaleLowerCase()
/** Only notes count here: a picture or PDF a link names is looked up by the editor itself (`isFileTarget`). */
const noteOnly = (path: string | null | undefined): string | null => (path && /\.md$/i.test(path) ? path : null)
const ASK_AFTER_MS = 60
const FIND_AFTER_MS = 120

export type Asker = {
  resolveMany: (source: string, targets: string[]) => Promise<{ found: Record<string, string | null> }>
  find: (q: string, source: string) => Promise<Found[]>
}

const server: Asker = {
  resolveMany: (source, targets) => vaultApi.resolveMany(source, targets),
  find: (q, source) => vaultApi.findFrom(q, source),
}

export class LinkIndex {
  private known = new Map<string, string | null>()
  private waiting = new Set<string>()
  private asking = false
  private timer = 0
  private found = new Map<string, Suggestion[]>()
  private lastSuggestions: Suggestion[] = []
  private findTimer = 0
  private closed = false

  constructor(
    readonly notePath: string,
    private changed: () => void = () => undefined,
    private asker: Asker = server,
  ) {}

  /** Who is told when answers came in (the editor, to draw its links again). */
  listen(changed: () => void) {
    this.changed = changed
    this.closed = false
  }

  /** Links the server resolved when the note was saved. */
  seed(outgoing: Outgoing[]) {
    for (const link of outgoing) {
      if (link.kind !== 'wiki' && link.kind !== 'embed') continue
      const name = linkName(link.target)
      if (name) this.known.set(fold(name), noteOnly(link.path))
    }
  }

  /** The vault path a target leads to; null when there is none, or when nobody knows yet (then it is asked). */
  resolve(target: string): string | null {
    const name = linkName(target)
    if (!name) return this.notePath
    const key = fold(name)
    if (this.known.has(key)) return this.known.get(key) ?? null
    this.ask(name)
    return null
  }

  /** Is there something at the end of the link? Unknown counts as yes until the server says otherwise. */
  exists(target: string): boolean {
    const name = linkName(target)
    if (!name) return true
    const key = fold(name)
    if (!this.known.has(key)) {
      this.ask(name)
      return true
    }
    // Files other than notes (pictures, PDFs) the editor looks up itself.
    return this.known.get(key) !== null || isFileTarget(target)
  }

  /** Where a link leads, waiting for the server when it was not asked before: for following a click. */
  async resolveNow(target: string): Promise<string | null> {
    const name = linkName(target)
    if (!name) return this.notePath
    const key = fold(name)
    if (!this.known.has(key)) {
      const answer = await this.asker.resolveMany(this.notePath, [name])
      this.known.set(key, noteOnly(answer.found[name]))
    }
    return this.known.get(key) ?? null
  }

  /** Forget what is known about names that may have changed (a note was made or renamed). */
  forget(target?: string) {
    if (target === undefined) this.known.clear()
    else this.known.delete(fold(linkName(target)))
    this.found.clear()
  }

  private ask(name: string) {
    if (this.closed) return
    this.waiting.add(name)
    if (this.timer || this.asking) return
    this.timer = window.setTimeout(() => void this.flush(), ASK_AFTER_MS)
  }

  private async flush() {
    this.timer = 0
    const names = [...this.waiting].slice(0, 200)
    if (!names.length) return
    for (const name of names) this.waiting.delete(name)
    this.asking = true
    try {
      const answer = await this.asker.resolveMany(this.notePath, names)
      for (const name of names) this.known.set(fold(name), noteOnly(answer.found[name]))
      if (!this.closed) this.changed()
    } catch {
      // Asked again the next time the editor wants to know.
    } finally {
      this.asking = false
      if (this.waiting.size && !this.closed) this.timer = window.setTimeout(() => void this.flush(), ASK_AFTER_MS)
    }
  }

  /** Suggestions after `[[`: what the server found for this query, or, while it is asked, the last ones. */
  search(query: string): Suggestion[] {
    const key = query.trim()
    const ready = this.found.get(key)
    if (ready) return (this.lastSuggestions = ready)
    window.clearTimeout(this.findTimer)
    this.findTimer = window.setTimeout(() => {
      this.asker
        .find(key, this.notePath)
        .then((hits) => {
          const space = this.notePath.split('/')[0]
          const items = hits.map((hit) => {
            const inSpace = hit.path.slice(space.length + 1).replace(/\.md$/i, '')
            return { label: hit.title || inSpace.split('/').pop()!, detail: inSpace, insert: hit.link ?? inSpace }
          })
          this.found.set(key, items)
          for (const hit of hits) {
            if (hit.link) this.known.set(fold(hit.link), hit.path)
          }
          if (!this.closed) this.changed()
        })
        .catch(() => undefined)
    }, FIND_AFTER_MS)
    return this.lastSuggestions
  }

  close() {
    this.closed = true
    window.clearTimeout(this.timer)
    window.clearTimeout(this.findTimer)
  }
}
