/**
 * Colours of the map. The server picks a palette slot for every group right below a space (`graphstore._colour`:
 * FNV-1a of the group's key); the sidebar and the search work out the same slot from a path, so a folder has one
 * colour everywhere without the whole graph in the browser.
 *
 * The colours follow the theme (`mapColours`): nexlore's own dark theme shows `PALETTE` as it is; another accent turns
 * every hue by as much as the accent lies from nexlore's turquoise, a light background darkens them so they stand on
 * it, and the grey is the theme's muted text. Worked out again after every change of theme (`THEME_EVENT`).
 */
import { THEME_EVENT } from '../lib/theme'

export const PALETTE = ['#2dd4bf', '#a78bfa', '#fbbf24', '#fb7185', '#38bdf8', '#a3e635', '#fb923c', '#f472b6', '#34d399', '#818cf8']
export const SPACE_COLORS = ['#5eead4', '#c4b5fd', '#fcd34d']
export const GREY = '#9a9aa8'
/** The accent the palette was made for (nexlore's turquoise). */
const OWN_ACCENT = PALETTE[0]
/** On a light background every colour keeps this share of its lightness. */
const LIGHT_DARKEN = 0.72

/** What of a theme the map's colours come from. */
export type ThemeSample = { accent: string; bg: string; muted: string }
export type MapColours = { slots: string[]; spaces: string[]; grey: string }

type Hsl = [number, number, number]

function parse(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const value = parseInt(match[1], 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function toHsl([r, g, b]: [number, number, number]): Hsl {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255]
  const max = Math.max(rr, gg, bb)
  const min = Math.min(rr, gg, bb)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === rr ? (gg - bb) / d + (gg < bb ? 6 : 0) : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4
  return [h * 60, s, l]
}

function toHex([h, s, l]: Hsl): string {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return '#' + [f(0), f(8), f(4)].map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('')
}

/** Relative luminance (WCAG): above one half the background counts as light. */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** The map's colours for a theme; a colour that cannot be read counts as nexlore's own. */
export function coloursFor(theme: ThemeSample): MapColours {
  const accent = parse(theme.accent)
  const bg = parse(theme.bg)
  const own = toHsl(parse(OWN_ACCENT)!)
  const shown = accent ? toHsl(accent) : own
  // A grey accent has no hue to follow.
  const turn = shown[1] > 0.15 ? shown[0] - own[0] : 0
  const light = bg ? luminance(bg) > 0.5 : false
  const adapt = (hex: string) => {
    if (!turn && !light) return hex
    const [h, s, l] = toHsl(parse(hex)!)
    return toHex([(h + turn + 360) % 360, s, light ? l * LIGHT_DARKEN : l])
  }
  return { slots: PALETTE.map(adapt), spaces: SPACE_COLORS.map(adapt), grey: parse(theme.muted) ? theme.muted.trim().toLowerCase() : GREY }
}

let current: MapColours | null = null

/** The colours for the theme the page shows now. */
export function mapColours(): MapColours {
  if (current) return current
  const style = typeof document === 'undefined' ? null : getComputedStyle(document.documentElement)
  const read = (name: string) => style?.getPropertyValue(name).trim() ?? ''
  current = coloursFor({ accent: read('--color-accent-500'), bg: read('--color-ink-950'), muted: read('--color-mist-500') })
  return current
}

// Registered when the module loads, so before any map listens: the map reads the new colours.
if (typeof window !== 'undefined') window.addEventListener(THEME_EVENT, () => (current = null))

/** FNV-1a over the UTF-8 bytes, 32 bits: the same number as the server's. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  return hash >>> 0
}

export function slotColor(slot: number): string {
  const colours = mapColours()
  return slot < 0 ? colours.grey : colours.slots[slot % colours.slots.length]
}

/** The colour of a space: by its place in the list of spaces one may read. */
export function spaceColor(index: number): string {
  const { spaces } = mapColours()
  return spaces[index % spaces.length]
}

/** The colour a note or folder has on the map in the folder cloud: that of its top folder, grey at the top of a space. */
export function folderColor(path: string, isFolder = false): string {
  const parts = path.split('/')
  const depth = isFolder ? parts.length : parts.length - 1
  if (depth < 2) return mapColours().grey
  return slotColor(fnv1a('f:' + parts[1]) % PALETTE.length)
}
