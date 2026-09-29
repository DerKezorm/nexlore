/**
 * Paths in the vault, as the API speaks them: `Space/Folder/Note.md`. The first part is the space.
 *
 * Until M5 this file also turned the whole vault into a tree for the graph and the sidebar; that is gone. The graph
 * loads its circles and tiles from the server (`graph/`), the sidebar reads folders when they open.
 */

/**
 * The address of a note's page. Every part encoded on its own: `#`, `?` and `%` are legal in file names and would
 * otherwise end the path in the address bar.
 */
export function noteUrl(path: string): string {
  return '/note/' + path.split('/').map(encodeURIComponent).join('/')
}

/** The note an address shows (the reverse of `noteUrl`), or null for any other page. */
export function notePathOf(pathname: string): string | null {
  if (!pathname.startsWith('/note/')) return null
  try {
    return pathname.slice('/note/'.length).split('/').map(decodeURIComponent).join('/') || null
  } catch {
    return null
  }
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
