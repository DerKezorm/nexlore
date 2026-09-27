/**
 * Colours of the map. The server picks a palette slot for every group right below a space (`graphstore._colour`:
 * FNV-1a of the group's key); the sidebar and the search work out the same slot from a path, so a folder has one
 * colour everywhere without the whole graph in the browser.
 */

export const PALETTE = ['#2dd4bf', '#a78bfa', '#fbbf24', '#fb7185', '#38bdf8', '#a3e635', '#fb923c', '#f472b6', '#34d399', '#818cf8']
export const SPACE_COLORS = ['#5eead4', '#c4b5fd', '#fcd34d']
export const GREY = '#9a9aa8'

/** FNV-1a over the UTF-8 bytes, 32 bits: the same number as the server's. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  return hash >>> 0
}

export function slotColor(slot: number): string {
  return slot < 0 ? GREY : PALETTE[slot % PALETTE.length]
}

/** The colour of a space: by its place in the list of spaces one may read. */
export function spaceColor(index: number): string {
  return SPACE_COLORS[index % SPACE_COLORS.length]
}

/** The colour a note or folder has on the map in the folder cloud: that of its top folder, grey at the top of a space. */
export function folderColor(path: string, isFolder = false): string {
  const parts = path.split('/')
  const depth = isFolder ? parts.length : parts.length - 1
  if (depth < 2) return GREY
  return slotColor(fnv1a('f:' + parts[1]) % PALETTE.length)
}
