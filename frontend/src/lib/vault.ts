/**
 * Turns the flat note list into what the interface needs: a folder tree (the clusters of the graph),
 * resolved wiki links and backlinks.
 */
import type { Note } from '../mock/notes'

export type Cluster = {
  id: string
  name: string
  /** 0 is the invisible root, 1 a space, 2 and deeper are folders. */
  depth: number
  parent: Cluster | null
  children: Cluster[]
  notes: Note[]
  /** All notes below, including those in subfolders. */
  total: number
  color: string
}

export type Link = { from: string; to: string }

export type Vault = {
  root: Cluster
  clusters: Map<string, Cluster>
  notes: Map<string, Note>
  byTitle: Map<string, Note>
  /** Folder a note sits in directly. */
  home: Map<string, Cluster>
  links: Link[]
  outgoing: Map<string, string[]>
  backlinks: Map<string, string[]>
}

/** Colors for the folders directly below a space; deeper folders inherit theirs. */
const PALETTE = ['#2dd4bf', '#a78bfa', '#fbbf24', '#fb7185', '#38bdf8', '#a3e635', '#fb923c', '#f472b6', '#34d399', '#818cf8']
const SPACE_COLORS = ['#5eead4', '#c4b5fd', '#fcd34d']

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g

export function linkTargets(body: string): { title: string; label: string }[] {
  const found: { title: string; label: string }[] = []
  for (const match of body.matchAll(WIKILINK)) {
    const title = match[1].trim()
    found.push({ title, label: (match[2] ?? title).trim() })
  }
  return found
}

export function buildVault(list: Note[]): Vault {
  const root: Cluster = { id: '', name: '', depth: 0, parent: null, children: [], notes: [], total: 0, color: '#9a9aa8' }
  const clusters = new Map<string, Cluster>([['', root]])
  const home = new Map<string, Cluster>()
  let paletteIndex = 0

  for (const note of list) {
    let current = root
    note.path.forEach((name, index) => {
      const id = note.path.slice(0, index + 1).join('/')
      let child = clusters.get(id)
      if (!child) {
        const depth = index + 1
        const color =
          depth === 1
            ? SPACE_COLORS[root.children.length % SPACE_COLORS.length]
            : depth === 2
              ? PALETTE[paletteIndex++ % PALETTE.length]
              : current.color
        child = { id, name, depth, parent: current, children: [], notes: [], total: 0, color }
        clusters.set(id, child)
        current.children.push(child)
      }
      current = child
    })
    current.notes.push(note)
    home.set(note.id, current)
    for (let c: Cluster | null = current; c; c = c.parent) c.total++
  }

  const notes = new Map(list.map((n) => [n.id, n]))
  const byTitle = new Map(list.map((n) => [n.title.toLowerCase(), n]))
  const links: Link[] = []
  const outgoing = new Map<string, string[]>()
  const backlinks = new Map<string, string[]>()
  const seen = new Set<string>()

  for (const note of list) {
    const targets: string[] = []
    for (const { title } of linkTargets(note.body)) {
      const target = byTitle.get(title.toLowerCase())
      if (!target || target.id === note.id || targets.includes(target.id)) continue
      targets.push(target.id)
      const key = note.id < target.id ? note.id + '|' + target.id : target.id + '|' + note.id
      if (!seen.has(key)) {
        seen.add(key)
        links.push({ from: note.id, to: target.id })
      }
      const back = backlinks.get(target.id) ?? []
      back.push(note.id)
      backlinks.set(target.id, back)
    }
    outgoing.set(note.id, targets)
  }

  return { root, clusters, notes, byTitle, home, links, outgoing, backlinks }
}

/** Space, folders, subfolders of a note, from the top down, without the root. */
export function ancestry(vault: Vault, noteId: string): Cluster[] {
  const chain: Cluster[] = []
  for (let c = vault.home.get(noteId) ?? null; c && c.depth > 0; c = c.parent) chain.unshift(c)
  return chain
}

export function neighbours(vault: Vault, noteId: string): Set<string> {
  return new Set([...(vault.outgoing.get(noteId) ?? []), ...(vault.backlinks.get(noteId) ?? [])])
}
