/** What every card of a canvas needs from the page around it. */
import { createContext, useContext } from 'react'

import type { LinkIndex } from '../lib/links'

export type NoteCache = {
  /** A note's text, loaded once per canvas (and again after it was saved beside it); null when it is not there. */
  get: (path: string) => Promise<string | null>
  /** Told when a note changed, so its card loads again. */
  forget: (path: string) => void
  /** Counts each `forget`, for cards to notice. */
  readonly generation: number
}

export type CanvasCards = {
  /** The canvas's own path, and the space it lies in (its cards' paths start at the top of that space). */
  path: string
  space: string
  readonly: boolean
  /** A finger on a phone: cards are not arranged there, only read and their text edited. */
  touch: boolean
  /** The text card being edited, if any. */
  editing: string | null
  setEditing: (id: string | null) => void
  /** A text card's new text, while it is being edited (`live`) or when editing ends. */
  setText: (id: string, text: string, live: boolean) => void
  openNote: (path: string) => void
  openFile: (path: string) => void
  /**
   * Where a card's path (as the file writes it) leads: from the top of the canvas's space, or of the whole vault with
   * another space's name in front, as the server found it with the rights of whoever looks. `locked`: it lies in a
   * space they may not read.
   */
  target: (written: string) => { path: string; locked: boolean }
  /** A card just laid down from another space: where it leads, until the server knows it. */
  remember: (written: string, path: string) => void
  notes: NoteCache
  /** Where wiki links in text cards lead, asked from where the canvas lies. */
  links: LinkIndex
  /** The layer for the editor's menus (bar, slash menu), outside the zoomed canvas. */
  menus: HTMLElement | null
}

export const CardsContext = createContext<CanvasCards | null>(null)

export function useCards(): CanvasCards {
  const cards = useContext(CardsContext)
  if (!cards) throw new Error('a card outside a canvas')
  return cards
}

/** A card's path from the top of its space as a vault path: Obsidian on the whole vault writes the space in front. */
export function vaultPath(space: string, written: string): string {
  const clean = written.replace(/^\/+/, '')
  return clean.toLowerCase().startsWith(space.toLowerCase() + '/') ? space + clean.slice(space.length) : `${space}/${clean}`
}

/** A vault path as a card writes it: from the top of the space, or with the other space's name in front. */
export function writtenPath(space: string, path: string): string {
  return path.startsWith(space + '/') ? path.slice(space.length + 1) : path
}

export type Targets = { cards: Record<string, string | null>; locked: Set<string> }

/**
 * Where a card leads: what the server said (it knows the rights and the other spaces), else a card laid down here
 * since, else the path from the top of the canvas's space. Where the server found nothing, the path from the top of
 * the space too: the card then says the note is missing.
 */
export function targetOf(space: string, targets: Targets, placed: Map<string, string>, written: string): { path: string; locked: boolean } {
  if (targets.locked.has(written)) return { path: vaultPath(space, written), locked: true }
  const known = targets.cards[written]
  if (known) return { path: known, locked: false }
  return { path: placed.get(written) ?? vaultPath(space, written), locked: false }
}
