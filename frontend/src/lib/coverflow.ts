/**
 * The cover flow (`components/Coverflow.tsx`): spaces and folders as cards with a cover picture, flipped through like
 * a shelf of records, a folder opening one level deeper, a note read where it stands. Opened from anywhere with
 * `askCoverflow`; the overlay lives in the app's frame.
 *
 * Here what can be worked out without a page: where each card stands, which card a few typed letters lead to.
 */

export const COVERFLOW_EVENT = 'nexlore:coverflow'

/** Opens the cover flow at a folder (a vault path), or at the spaces with "". */
export function askCoverflow(path = ''): void {
  window.dispatchEvent(new CustomEvent<string>(COVERFLOW_EVENT, { detail: path }))
}

export type Placed = {
  x: number
  z: number
  /** Degrees about the upright axis: cards to the left turn their face to the right, and the other way. */
  turn: number
  opacity: number
  /** How much darker than the card in the middle, 0 to 1. */
  dim: number
  hidden: boolean
}

/** Cards on either side that are drawn; further ones fade and go. */
export const SIDE = 4

/**
 * Where the card at `offset` places from the middle stands (a fraction while dragging): fanned, the next card
 * beside the middle one, the rest closer together and further back. `width` is a card's width in pixels.
 */
export function place(offset: number, width: number): Placed {
  const far = Math.abs(offset)
  const side = Math.sign(offset)
  const near = Math.min(far, 1)
  const beyond = Math.max(far - 1, 0)
  return {
    x: side * (near * width * 0.82 + beyond * width * 0.5),
    z: -near * 150 - beyond * 70,
    turn: -side * near * 30,
    opacity: far > SIDE + 1 ? 0 : far > SIDE ? SIDE + 1 - far : 1,
    dim: Math.min(far * 0.22, 0.62),
    hidden: far > SIDE + 1.2,
  }
}

/** The first card whose name begins with what was typed (case and accents aside), or -1. */
export function typedTo(names: string[], typed: string): number {
  const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()
  const wanted = fold(typed)
  if (!wanted) return -1
  return names.findIndex((name) => fold(name).startsWith(wanted))
}

/** Where a card lands after a drag: where it was let go, carried on a little by the speed of the hand. */
export function settle(position: number, velocity: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.round(position - velocity * 2.2)))
}

/** The parts of a vault path, each with the path up to it: for the line of places at the top. */
export function trail(path: string): { name: string; path: string }[] {
  if (!path) return []
  const parts = path.split('/')
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }))
}
