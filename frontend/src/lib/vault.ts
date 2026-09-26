/**
 * Turns the server's notes and links into what the interface needs: a folder tree (the clusters of the graph),
 * outgoing links and backlinks.
 *
 * A note's id is its path in the vault (`Space/Folder/Note.md`): that is what the API speaks and what the address
 * bar shows. Links come resolved from the server, which follows Obsidian's rules; nothing is guessed here.
 */
import type { Graph } from '../api/client'

export type Note = {
  /** Path in the vault, `Space/Folder/Note.md`. */
  id: string
  fileId: number
  title: string
  /** Folder path, first entry is the space. */
  path: string[]
  /** Written by an AI assistant through the MCP server (M7); not in use yet. */
  aiDraft?: boolean
  /** Somebody else is editing the note right now. */
  lockedBy?: string
}

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
  /** Folder a note sits in directly. */
  home: Map<string, Cluster>
  links: Link[]
  outgoing: Map<string, string[]>
  backlinks: Map<string, string[]>
}

/** Colors for the folders directly below a space; deeper folders inherit theirs. */
const PALETTE = ['#2dd4bf', '#a78bfa', '#fbbf24', '#fb7185', '#38bdf8', '#a3e635', '#fb923c', '#f472b6', '#34d399', '#818cf8']
const SPACE_COLORS = ['#5eead4', '#c4b5fd', '#fcd34d']

export function noteFromPath(fileId: number, path: string, title: string): Note {
  const parts = path.split('/')
  return { id: path, fileId, title, path: parts.slice(0, -1) }
}

export function buildVault(list: Note[], pairs: Link[]): Vault {
  const root: Cluster = { id: '', name: '', depth: 0, parent: null, children: [], notes: [], total: 0, color: '#9a9aa8' }
  const clusters = new Map<string, Cluster>([['', root]])
  const home = new Map<string, Cluster>()
  let paletteIndex = 0
  const sorted = [...list].sort((a, b) => a.id.localeCompare(b.id))

  for (const note of sorted) {
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

  const notes = new Map(sorted.map((n) => [n.id, n]))
  const links: Link[] = []
  const outgoing = new Map<string, string[]>()
  const backlinks = new Map<string, string[]>()
  const seen = new Set<string>()
  for (const { from, to } of pairs) {
    if (from === to || !notes.has(from) || !notes.has(to)) continue
    const out = outgoing.get(from) ?? []
    if (out.includes(to)) continue
    out.push(to)
    outgoing.set(from, out)
    const back = backlinks.get(to) ?? []
    back.push(from)
    backlinks.set(to, back)
    const key = from < to ? from + '|' + to : to + '|' + from
    if (!seen.has(key)) {
      seen.add(key)
      links.push({ from, to })
    }
  }

  return { root, clusters, notes, home, links, outgoing, backlinks }
}

/** The server's graph of every space as one vault. */
export function vaultFromGraphs(graphs: Graph[]): Vault {
  const list: Note[] = []
  const pairs: Link[] = []
  for (const graph of graphs) {
    const byId = new Map<number, string>()
    for (const [id, path, title] of graph.nodes) {
      byId.set(id, path)
      list.push(noteFromPath(id, path, title))
    }
    for (const [from, to] of graph.links) {
      const a = byId.get(from)
      const b = byId.get(to)
      if (a && b) pairs.push({ from: a, to: b })
    }
  }
  return buildVault(list, pairs)
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

/**
 * The address of a note's page. Every part encoded on its own: `#`, `?` and `%` are legal in file names and would
 * otherwise end the path in the address bar.
 */
export function noteUrl(path: string): string {
  return '/note/' + path.split('/').map(encodeURIComponent).join('/')
}

/** The folder part of a vault path: `Space/Folder` of `Space/Folder/Note.md`. */
export function folderOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? path : path.slice(0, index)
}

/** The file name without `.md`. */
export function baseName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name
}
