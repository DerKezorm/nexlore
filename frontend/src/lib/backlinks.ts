/**
 * Backlinks once per note: the server lists every link, so a note linking here twice came twice, with nothing to tell
 * the two apart. Here each note comes once, in the server's order, with how often it links and the first line it
 * does so in.
 */
import type { Backlink } from '../api/client'

export type BacklinkNote = { path: string; title: string; count: number; line: number; context: string | null }

export function backlinkNotes(backlinks: Backlink[]): BacklinkNote[] {
  const byPath = new Map<string, BacklinkNote>()
  for (const item of backlinks) {
    const known = byPath.get(item.path)
    if (known) {
      known.count += 1
      if (!known.context && item.context) known.context = item.context
    } else {
      byPath.set(item.path, { path: item.path, title: item.title, count: 1, line: item.line, context: item.context ?? null })
    }
  }
  return [...byPath.values()]
}
