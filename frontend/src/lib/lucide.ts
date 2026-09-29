/**
 * The Lucide symbols (ISC licence) for spaces and folders, stored as "l:<name>" next to the own ones of `symbols.ts`.
 * Their data (`lucide.json`, made by `npm run icons`) is loaded only when needed: the symbol dialog opens, or a space
 * or folder has one. Searched by name and by Lucide's English words, and by German words (`iconWordsDe.ts`).
 */
import { useEffect, useState } from 'react'

import { GERMAN_WORDS } from './iconWordsDe'

export type LucideIcon = { p: string[]; t: string[] }
export type Lucide = Record<string, LucideIcon>

export const PREFIX = 'l:'
const EVENT = 'nexlore:lucide'
let data: Lucide | null = null
let loading: Promise<Lucide> | null = null

export function isLucide(name: string | null | undefined): name is string {
  return !!name && name.startsWith(PREFIX)
}

export function loadLucide(): Promise<Lucide> {
  loading ??= import('./lucide.json').then((module) => {
    data = module.default as Lucide
    window.dispatchEvent(new Event(EVENT))
    return data
  })
  return loading
}

/** The paths of a Lucide symbol once loaded (the map draws them), else nothing yet. */
export function lucidePaths(name: string): string[] | undefined {
  return isLucide(name) ? data?.[name.slice(PREFIX.length)]?.p : undefined
}

/** The data, loaded on first use when `wanted`; null until it is there. */
export function useLucide(wanted = true): Lucide | null {
  const [loaded, setLoaded] = useState<Lucide | null>(data)
  useEffect(() => {
    if (!wanted) return
    const done = () => setLoaded(data)
    window.addEventListener(EVENT, done)
    if (data) setLoaded(data)
    else void loadLucide()
    return () => window.removeEventListener(EVENT, done)
  }, [wanted])
  return loaded
}

/**
 * The names that match a search, best first: the name itself, then Lucide's words, then German words translated.
 * Every word of the search must match (so "arrow up" finds the arrows pointing up).
 */
export function searchLucide(all: Lucide, query: string, limit = 240): string[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const scored: [number, string][] = []
  for (const [name, icon] of Object.entries(all)) {
    let score = 0
    for (const word of words) {
      const english = [word, ...(GERMAN_WORDS[word] ?? []), ...germanStems(word)]
      const inName = english.some((term) => name.includes(term))
      const inTags = english.some((term) => icon.t.some((tag) => tag.includes(term)))
      if (!inName && !inTags) {
        score = -1
        break
      }
      score += inName ? (name === word || name.startsWith(word + '-') ? 3 : 2) : 1
    }
    if (score > 0) scored.push([score, name])
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].length - b[1].length || a[1].localeCompare(b[1]))
  return scored.slice(0, limit).map(([, name]) => PREFIX + name)
}

/** German words typed in part ("fahrr" for "fahrrad"): the English ones of every German word it begins. */
function germanStems(word: string): string[] {
  if (word.length < 3) return []
  const out: string[] = []
  for (const [german, english] of Object.entries(GERMAN_WORDS)) if (german !== word && german.startsWith(word)) out.push(...english)
  return out
}
