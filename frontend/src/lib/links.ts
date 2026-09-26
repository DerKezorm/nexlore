/**
 * Wiki links in the editor, resolved in the browser the way the server does it for saved notes (Obsidian's rules,
 * simplified): a name finds a note of that name in the same space, a path finds the note at that path. The server
 * stays the authority; this only decides the colour of a link while typing and what `[[` suggests.
 */
import type { Suggestion } from '../editor/suggest'
import type { Vault } from './vault'

export type LinkIndex = {
  /** The vault path a target points to, or null. */
  resolve: (target: string) => string | null
  exists: (target: string) => boolean
  /** Every note of the space, with the text a link to it needs (the name, or the path where names repeat). */
  suggestions: Suggestion[]
}

const fold = (text: string) => text.normalize('NFC').toLocaleLowerCase()
const withoutMd = (path: string) => path.replace(/\.md$/i, '')

export function linkIndex(vault: Vault, notePath: string): LinkIndex {
  const space = notePath.split('/')[0]
  const folder = notePath.split('/').slice(0, -1).join('/')
  const byName = new Map<string, string[]>()
  const byPath = new Map<string, string>()
  for (const id of vault.notes.keys()) {
    if (id.split('/')[0] !== space) continue
    const inSpace = withoutMd(id.slice(space.length + 1))
    const name = inSpace.split('/').pop()!
    byName.set(fold(name), [...(byName.get(fold(name)) ?? []), id])
    byPath.set(fold(inSpace), id)
    byPath.set(fold(withoutMd(id)), id)
  }

  const resolve = (target: string): string | null => {
    const name = fold(withoutMd(target.split('#')[0].trim()))
    if (!name) return notePath // a link to a heading of this note
    if (name.includes('/')) return byPath.get(name.replace(/^\//, '')) ?? null
    const found = byName.get(name)
    if (!found) return null
    // Obsidian: the note in the same folder first, then the one with the shortest path.
    return found.find((id) => id.split('/').slice(0, -1).join('/') === folder) ?? [...found].sort((a, b) => a.length - b.length)[0]
  }

  const suggestions: Suggestion[] = []
  for (const [, ids] of byName) {
    for (const id of ids) {
      const inSpace = withoutMd(id.slice(space.length + 1))
      const name = inSpace.split('/').pop()!
      suggestions.push({ label: vault.notes.get(id)?.title || name, detail: inSpace, insert: ids.length > 1 ? inSpace : name })
    }
  }
  suggestions.sort((a, b) => a.label.localeCompare(b.label))

  return {
    resolve,
    // Files other than notes (pictures, PDFs) are not in the vault list yet (M3): they count as there.
    exists: (target) => resolve(target) !== null || /\.(?!md$)[a-z0-9]{1,5}$/i.test(target.split('#')[0].trim()),
    suggestions,
  }
}
