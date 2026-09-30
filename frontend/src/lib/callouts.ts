/**
 * Callouts get a symbol before their title, as in Obsidian, and a theme may give a kind its own colours and symbol or
 * bring kinds of its own (`colours.callouts` of a theme, checked by the server). Everything is drawn by CSS: a colour
 * variable and a mask per kind, so another theme shows at once in the reading view and in the editor.
 */
import { SYMBOLS, type Path, type SymbolName } from './symbols'

/** A kind's look in a theme: its colour in dark and in light (`#rrggbb`), and a symbol of `lib/symbols`. */
export type CalloutLook = { dark?: string; light?: string; icon?: string }
export type Callouts = Record<string, CalloutLook>

/** At most this many kinds in a theme; a kind is written as Obsidian writes it: small letters, digits, dashes. */
export const MAX_KINDS = 30
export const KIND = /^[a-z0-9-]{1,40}$/
const HEX = /^#[0-9a-f]{6}$/i

/** Obsidian's kinds and their symbols; a kind without one takes the note's. */
export const CALLOUT_ICONS: Record<string, SymbolName> = {
  note: 'pencil', abstract: 'clip', summary: 'clip', tldr: 'clip', info: 'info', todo: 'listTask', tip: 'sparkle',
  hint: 'sparkle', important: 'sparkle', success: 'check', check: 'check', done: 'check', question: 'info', help: 'info',
  faq: 'info', warning: 'alert', caution: 'alert', attention: 'alert', failure: 'close', fail: 'close', missing: 'close',
  danger: 'alert', error: 'alert', bug: 'tool', example: 'listBullet', quote: 'quote', cite: 'quote',
}

/** Symbols a theme may choose for a kind, in the editor's list. */
export const CALLOUT_SYMBOLS: SymbolName[] = [
  'pencil', 'info', 'sparkle', 'check', 'alert', 'close', 'tool', 'quote', 'listBullet', 'listTask', 'clip', 'star', 'heart',
  'idea', 'book', 'cooking', 'travel', 'money', 'health', 'school', 'code', 'calendar', 'clock', 'tag', 'link', 'leaf', 'home', 'work',
]

/** A symbol as a CSS image (a data address: the page's rules allow it, nothing is fetched). */
export function symbolImage(name: string): string | null {
  const paths = (SYMBOLS as Record<string, Path[] | undefined>)[name]
  if (!paths) return null
  const inner = paths
    .map((path) => (path.fill ? `<path d="${path.d}" fill="black"/>` : `<path d="${path.d}" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`))
    .join('')
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${inner}</svg>`)}")`
}

const selectors = (kind: string, scope: string) => {
  const inner = scope ? `${scope} ` : ''
  return `${inner}.nn-callout-${kind}, ${inner}.nx-callout-${kind}`
}

/** The symbols of Obsidian's kinds, for every page (a theme may change them). */
export function defaultCalloutCss(): string {
  const note = symbolImage('pencil')
  const rules = [`.nn-callout, .nx-callout { --nn-callout-icon: ${note}; }`]
  for (const [kind, icon] of Object.entries(CALLOUT_ICONS)) if (kind !== 'note') rules.push(`${selectors(kind, '')} { --nn-callout-icon: ${symbolImage(icon)}; }`)
  return rules.join('\n')
}

/** Only what may stand in a theme: known shapes, as many as allowed. */
export function cleanCallouts(incoming: unknown): Callouts {
  const out: Callouts = {}
  if (!incoming || typeof incoming !== 'object') return out
  for (const [kind, look] of Object.entries(incoming as Record<string, unknown>).slice(0, MAX_KINDS)) {
    if (!KIND.test(kind) || !look || typeof look !== 'object') continue
    const { dark, light, icon } = look as Record<string, unknown>
    const clean: CalloutLook = {}
    if (typeof dark === 'string' && HEX.test(dark)) clean.dark = dark.toLowerCase()
    if (typeof light === 'string' && HEX.test(light)) clean.light = light.toLowerCase()
    if (typeof icon === 'string' && symbolImage(icon)) clean.icon = icon
    out[kind] = clean
  }
  return out
}

/** A theme's callouts as CSS: the colours for dark and light, the symbols for both; `scope` for a space's notes. */
export function calloutCss(callouts: Callouts | undefined, scope = ''): string {
  const rules: string[] = []
  const inner = scope ? ` ${scope}` : ''
  for (const [kind, look] of Object.entries(cleanCallouts(callouts))) {
    const all = selectors(kind, '').split(', ')
    const under = (root: string) => all.map((selector) => `${root}${inner} ${selector}`).join(', ')
    if (look.dark) rules.push(`${under(":root:not([data-theme='light'])")} { --nn-callout: ${look.dark}; --nx-callout: ${look.dark}; }`)
    if (look.light) rules.push(`${under(":root[data-theme='light']")} { --nn-callout: ${look.light}; --nx-callout: ${look.light}; }`)
    if (look.icon) rules.push(`${selectors(kind, scope)} { --nn-callout-icon: ${symbolImage(look.icon)}; }`)
  }
  return rules.join('\n')
}
