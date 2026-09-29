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

/**
 * The links of a note for the list beside it: each place once, in the order of the first link, with how often the
 * note links there. A found link counts by where it leads (`[[Plan]]` and `[[Plan#Goals]]` are one place), a missing
 * one by the name it asks for.
 */
export function distinctOutgoing(outgoing: Outgoing[]): { link: Outgoing; count: number }[] {
  const seen = new Map<string, { link: Outgoing; count: number }>()
  for (const link of outgoing) {
    const key = link.path ? 'p:' + link.path : 'm:' + fold(linkName(link.target))
    const entry = seen.get(key)
    if (entry) entry.count += 1
    else seen.set(key, { link, count: 1 })
  }
  return [...seen.values()]
}

/**
 * The space a wiki link names in front (`[[Homelab/Why ZFS]]`), when it is another space the account can see, with
 * the rest of the path. Null for a link inside the own space, and for a space the account does not know: it only
 * knows the spaces it may read, so a link into any other looks like a link to a folder that is not there.
 */
export function linkedSpace(
  target: string,
  spaces: { name: string; role: string }[],
  own: string,
): { space: string; role: string; rest: string } | null {
  const name = linkName(target).replace(/^\/+/, '')
  const slash = name.indexOf('/')
  if (slash <= 0 || !name.slice(slash + 1).trim()) return null
  const first = fold(name.slice(0, slash))
  if (first === fold(own)) return null
  const space = spaces.find((item) => fold(item.name) === first)
  return space ? { space: space.name, role: space.role, rest: name.slice(slash + 1).replace(/\/+$/, '') } : null
}
/** Only notes count here: a picture or PDF a link names is looked up by the editor itself (`isFileTarget`). */
const noteOnly = (path: string | null | undefined): string | null => (path && /\.md$/i.test(path) ? path : null)
const ASK_AFTER_MS = 60
/** "There is nothing" is asked again after this: the note may have been made elsewhere meanwhile. */
const MISSING_FOR_MS = 30_000
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
  /** When a target was answered with "nothing there". */
  private missingSince = new Map<string, number>()
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
      if (name) this.remember(fold(name), noteOnly(link.path))
    }
  }

  /** The vault path a target leads to; null when there is none, or when nobody knows yet (then it is asked). */
  resolve(target: string): string | null {
    const name = linkName(target)
    if (!name) return this.notePath
    const key = fold(name)
    if (this.known.has(key)) {
      this.askAgainIfOld(key, name)
      return this.known.get(key) ?? null
    }
    this.ask(name)
    return null
  }

  private remember(key: string, path: string | null) {
    this.known.set(key, path)
    if (path === null) this.missingSince.set(key, Date.now())
    else this.missingSince.delete(key)
  }

  private askAgainIfOld(key: string, name: string) {
    const since = this.missingSince.get(key)
    if (since !== undefined && Date.now() - since > MISSING_FOR_MS) {
      this.missingSince.set(key, Date.now())
      this.ask(name)
    }
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
    this.askAgainIfOld(key, name)
    // Files other than notes (pictures, PDFs) the editor looks up itself.
    return this.known.get(key) !== null || isFileTarget(target)
  }

  /** Where a link leads, asked from the server every time: a click that finds nothing makes a new note, and that
   * must never rest on an answer from before (the note may have been made elsewhere in between). */
  async resolveNow(target: string): Promise<string | null> {
    const name = linkName(target)
    if (!name) return this.notePath
    const answer = await this.asker.resolveMany(this.notePath, [name])
    const found = noteOnly(answer.found[name])
    this.remember(fold(name), found)
    return found
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
      for (const name of names) this.remember(fold(name), noteOnly(answer.found[name]))
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
            // A note of another space shows (and is linked) with that space's name in front.
            const own = hit.path.startsWith(space + '/')
            const shown = (own ? hit.path.slice(space.length + 1) : hit.path).replace(/\.md$/i, '')
            return { label: hit.title || shown.split('/').pop()!, detail: shown, insert: hit.link ?? shown }
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
