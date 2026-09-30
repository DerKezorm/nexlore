/**
 * Own keys for commands: chosen in the command palette (the keyboard beside a command, then the keys), kept with the
 * account (`appearance.keys`, the same on every device), and pressed anywhere in the app while the command is on
 * offer. Written as nexlore writes them everywhere: "Ctrl+Alt+Shift+Meta+Key", the key by its place on the keyboard
 * (`event.code`), so Alt with a letter on a Mac and other layouts give the same combination.
 *
 * Refused: a combination without Ctrl, Alt or Meta (it would take a letter from typing; F keys may stand alone), one
 * the browser keeps for itself, and one nexlore already uses.
 */

export type OwnKey = { combo: string; label: string }
export type OwnKeys = Record<string, OwnKey>

/** Keys named by their place, beyond letters, digits and F keys. */
const NAMED = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Space', 'Home', 'End', 'PageUp', 'PageDown', 'Insert',
  'Comma', 'Period', 'Slash', 'Minus', 'Equal', 'Semicolon', 'Quote', 'BracketLeft', 'BracketRight', 'Backslash', 'Backquote',
])

type Press = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>

/** The combination of a key press; null for a press of a modifier alone or of a key nexlore does not name. */
export function comboOf(press: Press): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(press.key)) return null
  let key: string | null = null
  if (/^Key[A-Z]$/.test(press.code)) key = press.code.slice(3)
  else if (/^Digit[0-9]$/.test(press.code)) key = press.code.slice(5)
  else if (/^F([1-9]|1[0-2])$/.test(press.code)) key = press.code
  else if (NAMED.has(press.code)) key = press.code
  if (!key) return null
  const mods = [press.ctrlKey && 'Ctrl', press.altKey && 'Alt', press.shiftKey && 'Shift', press.metaKey && 'Meta'].filter(Boolean)
  return [...mods, key].join('+')
}

/** What the browser keeps (a page never sees them, or must not take them). */
const BROWSER = new Set([
  'Ctrl+W', 'Ctrl+T', 'Ctrl+N', 'Ctrl+Shift+T', 'Ctrl+Shift+N', 'Ctrl+Shift+W', 'Ctrl+Q', 'Ctrl+L', 'Ctrl+R', 'Ctrl+Shift+R',
  'Meta+W', 'Meta+T', 'Meta+N', 'Meta+Q', 'Meta+L', 'Meta+R', 'Meta+H', 'Meta+M', 'Alt+F4', 'F5', 'F11', 'F12', 'Ctrl+Shift+I', 'Ctrl+Shift+J',
])

/** What nexlore and its editor already answer to. */
export const TAKEN = new Set([
  'Ctrl+K', 'Ctrl+P', 'Ctrl+Shift+F', 'Ctrl+F', 'Ctrl+H', 'F2', 'F3', 'Shift+F3', 'Alt+T', 'Alt+N', 'Alt+Shift+N', 'Alt+B', 'Alt+R',
  'Ctrl+Alt+B', 'Ctrl+B', 'Ctrl+I', 'Ctrl+U', 'Ctrl+E', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z', 'Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X',
  'Ctrl+S', 'Ctrl+Enter', 'Alt+ArrowUp', 'Alt+ArrowDown', 'Ctrl+Shift+ArrowUp', 'Ctrl+Shift+ArrowDown', 'Meta+K', 'Meta+P', 'Meta+Z', 'Meta+A', 'Meta+C', 'Meta+V', 'Meta+X', 'Meta+B', 'Meta+I',
])

export type Refusal = 'modifier' | 'browser' | 'taken'

/** Why a combination cannot be an own key; null when it can. */
export function refusal(combo: string): Refusal | null {
  const parts = combo.split('+')
  const key = parts[parts.length - 1]
  if (!/^F([1-9]|1[0-2])$/.test(key) && !parts.some((part) => part === 'Ctrl' || part === 'Alt' || part === 'Meta')) return 'modifier'
  if (BROWSER.has(combo)) return 'browser'
  if (TAKEN.has(combo)) return 'taken'
  return null
}

/** The own keys with `id` set to `combo` (another command that had it loses it); `combo` null removes it. */
export function withKey(keys: OwnKeys, id: string, label: string, combo: string | null): OwnKeys {
  const out: OwnKeys = {}
  for (const [other, own] of Object.entries(keys)) if (other !== id && own.combo !== combo) out[other] = own
  if (combo) out[id] = { combo, label }
  return out
}

/** The command an own key stands for, or null. */
export function commandFor(keys: OwnKeys, combo: string): string | null {
  for (const [id, own] of Object.entries(keys)) if (own.combo === combo) return id
  return null
}

/** Shown as on the keyboard: ⌘ on a Mac. */
export function shownCombo(combo: string, mac = /Mac|iPhone|iPad/.test(navigator.platform)): string {
  return combo.replace(/\bMeta\b/, mac ? '⌘' : 'Win').replace(/\+/g, ' + ')
}

/** While the palette listens for a new combination, the app's own keys stay quiet. */
let recording = false
export function setRecording(on: boolean): void {
  recording = on
}
export function isRecording(): boolean {
  return recording
}
