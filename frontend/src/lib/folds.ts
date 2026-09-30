/**
 * Folds: headings and list items with items below them are folded shut, in the reading view and in the editor alike,
 * remembered per note in this browser (as Obsidian keeps them per device). Only how the note is shown: the file never
 * changes.
 *
 * A fold is named by what it folds: `h2:Setup#0` is the first heading "Setup" of level 2, `l:Groceries#1` the second
 * list item that starts with "Groceries". A heading renamed forgets its fold.
 */

import { ownKey } from './accountStorage'

const KEY = 'nexlore.folds'
/** Notes remembered at most; the oldest go first. */
const MAX_NOTES = 300
export const FOLDS_EVENT = 'nexlore:folds'
/** "Fold all" or "unfold all" for a note: whoever shows it names the folds (it knows the headings). */
export const FOLD_ALL_EVENT = 'nexlore:fold-all'

type Stored = Record<string, string[]>

function readAll(): Stored {
  try {
    const raw = JSON.parse(localStorage.getItem(ownKey(KEY)) ?? '{}') as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Stored) : {}
  } catch {
    return {}
  }
}

function writeAll(all: Stored): void {
  const paths = Object.keys(all)
  // The newest last (re-inserted when written): too many, and the first ones go.
  for (const path of paths.slice(0, Math.max(0, paths.length - MAX_NOTES))) delete all[path]
  try {
    localStorage.setItem(ownKey(KEY), JSON.stringify(all))
  } catch {
    // Not remembered: folded as long as the page lasts.
  }
}

export function readFolds(path: string): Set<string> {
  const list = readAll()[path]
  return new Set(Array.isArray(list) ? list.filter((key) => typeof key === 'string') : [])
}

/** The folds of a note as a whole (nothing folded: forgotten). */
export function setFolds(path: string, keys: Iterable<string>): void {
  const all = readAll()
  const list = [...new Set(keys)]
  delete all[path]
  if (list.length) all[path] = list
  writeAll(all)
  window.dispatchEvent(new CustomEvent(FOLDS_EVENT, { detail: path }))
}

export function toggleFold(path: string, key: string): void {
  const folds = readFolds(path)
  if (folds.has(key)) folds.delete(key)
  else folds.add(key)
  setFolds(path, folds)
}

export function askFoldAll(path: string, fold: boolean): void {
  window.dispatchEvent(new CustomEvent(FOLD_ALL_EVENT, { detail: { path, fold } }))
}

/** Names the folds of a note in order: the same heading twice gets `#0` and `#1`. */
export function namer(): (kind: string) => string {
  const seen = new Map<string, number>()
  return (kind) => {
    const n = seen.get(kind) ?? 0
    seen.set(kind, n + 1)
    return `${kind}#${n}`
  }
}

export const headingKind = (level: number, text: string) => `h${level}:${text.trim().replace(/\s+/g, ' ').slice(0, 120)}`
export const itemKind = (text: string) => `l:${text.trim().replace(/\s+/g, ' ').slice(0, 120)}`
