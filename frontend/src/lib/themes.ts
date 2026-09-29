/**
 * Colour themes in the browser: the fifteen colours of a theme (`services/themes.py`) become nexlore's own colour
 * variables, for the whole app (the account's theme) or for the notes of a space (`data-space-theme`). The shades in
 * between (hover, the softer and brighter accent, the greys of the text) are mixed from them.
 *
 * Own CSS (the account's snippets) goes into style elements of its own, one per snippet.
 */

export const TOKENS = [
  'bg', 'bg-elev', 'surface', 'surface-hover', 'border', 'border-strong',
  'text', 'text-muted', 'text-faint', 'accent', 'on-accent', 'ok', 'warn', 'bad', 'ai',
] as const
export type Token = (typeof TOKENS)[number]
export type Palette = Partial<Record<Token, string>>
export type Colours = { dark?: Palette; light?: Palette }

export const TOKEN_GROUPS: [string, Token[]][] = [
  ['surfaces', ['bg', 'bg-elev', 'surface', 'surface-hover']],
  ['lines', ['border', 'border-strong']],
  ['text', ['text', 'text-muted', 'text-faint']],
  ['accent', ['accent', 'on-accent']],
  ['status', ['ok', 'warn', 'bad', 'ai']],
]

/** nexlore's own colours (styles/index.css), the start of a new theme. */
export const NEXLORE_COLOURS: Required<Record<'dark' | 'light', Required<Palette>>> = {
  dark: {
    bg: '#0b0b0f', 'bg-elev': '#101016', surface: '#16161d', 'surface-hover': '#1d1d26', border: '#26262f', 'border-strong': '#3a3a46',
    text: '#f2f2f5', 'text-muted': '#9a9aa8', 'text-faint': '#6f6f80', accent: '#2dd4bf', 'on-accent': '#04201d',
    ok: '#4ade80', warn: '#fbbf24', bad: '#fb7185', ai: '#c4b5fd',
  },
  light: {
    bg: '#f5f5f8', 'bg-elev': '#ffffff', surface: '#ffffff', 'surface-hover': '#ececf2', border: '#dcdce4', 'border-strong': '#b4b4c2',
    text: '#14141a', 'text-muted': '#61616f', 'text-faint': '#8a8a97', accent: '#0d9488', 'on-accent': '#ffffff',
    ok: '#16a34a', warn: '#b45309', bad: '#e11d48', ai: '#6d28d9',
  },
}

const DIRECT: Record<Token, string[]> = {
  bg: ['--color-ink-950'],
  'bg-elev': ['--color-ink-900'],
  surface: ['--color-ink-850'],
  'surface-hover': ['--color-ink-800'],
  border: ['--color-ink-700'],
  'border-strong': ['--color-ink-600'],
  text: ['--color-mist-100'],
  'text-muted': ['--color-mist-500'],
  'text-faint': ['--color-mist-600'],
  accent: ['--color-accent-500'],
  'on-accent': ['--color-on-accent'],
  ok: ['--color-ok-500'],
  warn: ['--color-warn-500'],
  bad: ['--color-bad-500'],
  ai: ['--color-ai-500'],
}

const HEX = /^#[0-9a-f]{6}$/i

/** The variable lines of one side of a theme; only colours that are there, and mixes of two that are there. */
function lines(palette: Palette): string[] {
  const out: string[] = []
  const has = (token: Token) => typeof palette[token] === 'string' && HEX.test(palette[token]!)
  for (const token of TOKENS) if (has(token)) for (const name of DIRECT[token]) out.push(`${name}: ${palette[token]};`)
  const mix = (name: string, a: Token, share: number, b: Token) => {
    if (has(a) && has(b)) out.push(`${name}: color-mix(in srgb, ${palette[a]} ${share}%, ${palette[b]});`)
  }
  mix('--color-mist-200', 'text', 85, 'text-muted')
  mix('--color-mist-300', 'text', 60, 'text-muted')
  mix('--color-mist-400', 'text', 30, 'text-muted')
  mix('--color-accent-400', 'accent', 80, 'text')
  mix('--color-accent-300', 'accent', 60, 'text')
  mix('--color-accent-600', 'accent', 85, 'bg')
  mix('--color-accent-700', 'accent', 60, 'bg')
  return out
}

/** A theme as CSS: `scope` empty for the whole page, else a selector the variables apply below (a space's notes). */
export function themeCss(colours: Colours | null | undefined, scope = ''): string {
  if (!colours) return ''
  const inner = scope ? ` ${scope}` : ''
  const parts: string[] = []
  const dark = colours.dark ? lines(colours.dark) : []
  const light = colours.light ? lines(colours.light) : []
  if (dark.length) parts.push(`:root:not([data-theme='light'])${inner} { ${dark.join(' ')} }`)
  if (light.length) parts.push(`:root[data-theme='light']${inner} { ${light.join(' ')} }`)
  if (scope) parts.push(`${scope} { background: var(--color-ink-950); color: var(--color-mist-100); }`)
  return parts.join('\n')
}

function styleElement(id: string): HTMLStyleElement {
  let element = document.getElementById(id) as HTMLStyleElement | null
  if (!element) {
    element = document.createElement('style')
    element.id = id
    document.head.append(element)
  }
  return element
}

/** The account's theme over the whole page; null: nexlore's own colours. */
export function applyThemeColours(colours: Colours | null | undefined): void {
  styleElement('nexlore-theme').textContent = themeCss(colours)
}

/** The selector for the notes of a space with a theme; the reference was checked by the server (t:12, plum). */
export function spaceScope(ref: string): string {
  return `[data-space-theme="${ref.replace(/[^A-Za-z0-9:_-]/g, '')}"]`
}

const spaceThemes = new Map<string, Promise<void>>()

/** Loads a space's theme once and lays it under its notes. */
export function ensureSpaceTheme(ref: string, load: (ref: string) => Promise<Colours>): void {
  if (!ref || ref === 'nexlore' || spaceThemes.has(ref)) return
  spaceThemes.set(
    ref,
    load(ref).then(
      (colours) => {
        styleElement(`nexlore-space-${ref.replace(/[^A-Za-z0-9_-]/g, '-')}`).textContent = themeCss(colours, spaceScope(ref))
      },
      () => {
        spaceThemes.delete(ref)
      },
    ),
  )
}

/** A space's theme changed (its manager chose another, or one was edited): load it again when it is next needed. */
export function forgetSpaceThemes(): void {
  spaceThemes.clear()
  document.querySelectorAll('style[id^="nexlore-space-"]').forEach((element) => element.remove())
}

/** The account's own CSS, a style element per snippet (one left open cannot take in the next). */
export function applyOwnCss(snippets: string[] | null | undefined): void {
  document.querySelectorAll('style.nexlore-snippet').forEach((element) => element.remove())
  for (const css of snippets ?? []) {
    const element = document.createElement('style')
    element.className = 'nexlore-snippet'
    element.textContent = css
    document.head.append(element)
  }
}

// --- Contrast, as the server checks it --------------------------------------------------------------------------

const TEXT: Token[] = ['text', 'text-muted', 'text-faint', 'accent', 'ok', 'warn', 'bad', 'ai']
const GROUNDS: Token[] = ['bg', 'bg-elev', 'surface']

function luminance(colour: string): number {
  const channel = (value: number) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16))
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrast(one: string, other: string): number {
  const a = luminance(one)
  const b = luminance(other)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

export type Weak = { mode: 'dark' | 'light'; token: Token; ratio: number }

export function weakSpots(colours: Colours): Weak[] {
  const found: Weak[] = []
  for (const mode of ['dark', 'light'] as const) {
    const palette = colours[mode] ?? {}
    for (const token of TEXT) {
      if (!palette[token]) continue
      const ratios = GROUNDS.filter((ground) => palette[ground]).map((ground) => contrast(palette[token]!, palette[ground]!))
      const worst = ratios.length ? Math.min(...ratios) : 21
      if (worst < 4.5) found.push({ mode, token, ratio: Math.round(worst * 100) / 100 })
    }
    if (palette.accent && palette['on-accent']) {
      const ratio = contrast(palette.accent, palette['on-accent'])
      if (ratio < 4.5) found.push({ mode, token: 'on-accent', ratio: Math.round(ratio * 100) / 100 })
    }
  }
  return found
}

// --- As a file ----------------------------------------------------------------------------------------------------

export type ThemeFile = { nexlore_theme: 1; name: string; colours: Colours }

export function themeFile(name: string, colours: Colours): string {
  return JSON.stringify({ nexlore_theme: 1, name, colours } satisfies ThemeFile, null, 2)
}

/** A theme file of nexlore, or one of nexdeck (the same colours but the AI's); null for anything else. */
export function readThemeFile(text: string): { name: string; colours: Colours } | null {
  try {
    const data = JSON.parse(text) as Record<string, unknown>
    const pick = (side: unknown): Palette | undefined => {
      if (!side || typeof side !== 'object') return undefined
      const out: Palette = {}
      for (const [key, value] of Object.entries(side as Record<string, unknown>)) {
        // nexdeck's "unknown" is a grey for a state nobody knows; nexlore has none, its AI colour stays its own.
        const token = key as Token
        if (TOKENS.includes(token) && typeof value === 'string' && HEX.test(value)) out[token] = value.toLowerCase()
      }
      return out
    }
    if (data.nexlore_theme === 1 && data.colours && typeof data.colours === 'object') {
      const colours = data.colours as Colours
      return { name: String(data.name ?? '').slice(0, 40), colours: { dark: pick(colours.dark), light: pick(colours.light) } }
    }
    if (data.nexdeck_theme === 1) return { name: String(data.name ?? '').slice(0, 40), colours: { dark: pick(data.dark), light: pick(data.light) } }
  } catch {
    // Not JSON.
  }
  return null
}
