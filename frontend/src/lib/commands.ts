/**
 * The command palette's list (Ctrl+P, as in Obsidian): whoever is on the screen adds its commands while it is there.
 * The app's frame adds the places and the daily ones, the note page what can be done with the note, the editor its
 * formats. Chosen commands come first next time (remembered in this browser).
 */
import { useEffect, useRef } from 'react'
import type { SymbolName } from '../components/Symbol'

export type Command = {
  /** Stable, also for the list of the ones used last. */
  id: string
  label: string
  /** Where it belongs, shown beside it ("Note", "Editor"). */
  group: string
  symbol?: SymbolName
  /** The keys that do the same, shown as a hint. */
  keys?: string
  /** More words it is found by ("zettel" for the note named by the minute). */
  keywords?: string
  run: () => void
}

export const PALETTE_EVENT = 'nexlore:palette'
const RECENT_KEY = 'nexlore.commands'
const RECENT_MAX = 6

const providers = new Map<number, () => Command[]>()
let counter = 0

/** Adds the commands `provide` returns while the component is mounted; asked each time the palette opens. */
export function useCommands(provide: () => Command[]): void {
  const latest = useRef(provide)
  useEffect(() => {
    latest.current = provide
  })
  useEffect(() => {
    const id = counter++
    providers.set(id, () => latest.current())
    return () => {
      providers.delete(id)
    }
  }, [])
}

/** Every command on offer now; the first with an id wins (the frame registers first). */
export function allCommands(): Command[] {
  const seen = new Set<string>()
  const out: Command[] = []
  for (const provide of providers.values())
    for (const command of provide()) {
      if (seen.has(command.id)) continue
      seen.add(command.id)
      out.push(command)
    }
  return out
}

export function askPalette(): void {
  window.dispatchEvent(new CustomEvent(PALETTE_EVENT))
}

export function recentCommands(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string').slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

export function rememberCommand(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentCommands().filter((other) => other !== id)].slice(0, RECENT_MAX)))
  } catch {
    // Not remembered: the order stays as it is.
  }
}

const fold = (text: string) => text.normalize('NFC').toLocaleLowerCase()

/**
 * The commands that fit what was typed: every word somewhere in the name or the group. Names that start with the
 * typing come first, then the ones used last, then the order they were added in.
 */
export function matchCommands(commands: Command[], query: string, recent: string[]): Command[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  const typed = fold(query.trim())
  const rank = (command: Command, index: number): [number, number, number] => {
    const used = recent.indexOf(command.id)
    return [typed && fold(command.label).startsWith(typed) ? 0 : 1, used < 0 ? RECENT_MAX : used, index]
  }
  return commands
    .map((command, index) => ({ command, index }))
    .filter(({ command }) => {
      const hay = fold(command.label + ' ' + command.group + ' ' + (command.keywords ?? ''))
      return words.every((word) => hay.includes(word))
    })
    .sort((a, b) => {
      const x = rank(a.command, a.index)
      const y = rank(b.command, b.index)
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
    })
    .map(({ command }) => command)
}
