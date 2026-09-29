/**
 * Symbols and colours of spaces and folders chosen by hand (`/api/looks`). A folder's colour holds for the folders
 * in it too, unless one of them has its own (as the colour nexlore works out does: the top folder's); a symbol only
 * for the folder itself. The colour of a space is its own and does not pass to its folders.
 */
import type { Looks } from '../api/client'

/** `icon`: an own symbol (`symbols.ts`) or a Lucide one ("l:<name>", `lucide.ts`). */
export type LookShown = { icon: string | null; color: string | null }

/** What a space or folder (a vault path) looks like by hand; null where nexlore's own holds. */
export function lookOf(looks: Looks, path: string): LookShown {
  const [space, ...rest] = path.split('/')
  const own = looks[space] ?? {}
  const icon = own[rest.join('/')]?.icon ?? null
  if (!rest.length) return { icon, color: own['']?.color ?? null }
  for (let parts = rest; parts.length; parts = parts.slice(0, -1)) {
    const color = own[parts.join('/')]?.color
    if (color) return { icon, color }
  }
  return { icon, color: null }
}
