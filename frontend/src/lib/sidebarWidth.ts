/**
 * How wide the sidebar is, as dragged at its right edge (or moved with the arrow keys there). Remembered in this
 * browser like the sidebar's other switches: a phone and a wide screen want different widths.
 */

export const USUAL_WIDTH = 256
const LEAST = 200
const MOST = 640
/** The page beside it keeps at least this much. */
const PAGE = 480
const KEY = 'nexlore.sidebarWidth'

/** A width the sidebar may have in this window. */
export function fitWidth(width: number, windowWidth = window.innerWidth): number {
  return Math.round(Math.max(LEAST, Math.min(width, MOST, windowWidth - PAGE)))
}

export function storedWidth(): number {
  try {
    const stored = Number(localStorage.getItem(KEY))
    return stored > 0 ? fitWidth(stored) : USUAL_WIDTH
  } catch {
    return USUAL_WIDTH
  }
}

export function keepWidth(width: number): void {
  try {
    if (width === USUAL_WIDTH) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, String(width))
  } catch {
    // Storage blocked: the width holds until the page is left.
  }
}
