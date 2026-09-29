/**
 * How nexlore looks for the signed-in account (stored with it on the server, `services/appearance.py`): light, dark
 * or as the system, the fonts, the text size and the width of the text. Applied as CSS variables on the page's root;
 * a font's files load the first time it is chosen, from nexlore itself (never another server).
 */
import { applyTheme, type Theme } from './theme'

export type Mode = 'dark' | 'light' | 'system'
export type FontUi = 'inter' | 'atkinson' | 'plex' | 'system'
export type FontText = 'inter' | 'literata' | 'source-serif' | 'atkinson' | 'plex' | 'system'
export type FontCode = 'jetbrains' | 'system'
export type Width = 'narrow' | 'normal' | 'wide' | 'full'

/** Where nexlore opens (Settings → General). */
export type Start = 'graph' | 'daily' | 'last' | 'note'

/** The tabs of the column beside a note. */
export type PanelTab = 'outline' | 'links' | 'comments' | 'graph' | 'versions' | 'plugins'

export type Appearance = {
  mode: Mode
  theme: string
  space_themes: boolean
  font_ui: FontUi
  font_text: FontText
  font_code: FontCode
  size: number
  width: Width
  start: Start
  start_note: string
  /** The column beside a note shown on a wide screen, its tab, and the sidebar open or folded to symbols. */
  panel: boolean
  panel_tab: PanelTab
  sidebar: 'open' | 'rail'
}

export const DEFAULT_APPEARANCE: Appearance = {
  mode: 'dark', theme: 'nexlore', space_themes: true, font_ui: 'inter', font_text: 'inter', font_code: 'jetbrains', size: 16, width: 'normal',
  start: 'graph', start_note: '', panel: true, panel_tab: 'links', sidebar: 'open',
}

type Font = { label: string; family: string; load?: () => Promise<unknown> }

export const FONTS: Record<FontText | FontUi | FontCode, Font> = {
  inter: { label: 'Inter', family: "'Inter Variable', 'Segoe UI', system-ui, sans-serif", load: () => import('@fontsource-variable/inter') },
  atkinson: {
    label: 'Atkinson Hyperlegible',
    family: "'Atkinson Hyperlegible Next Variable', Verdana, system-ui, sans-serif",
    load: () => import('@fontsource-variable/atkinson-hyperlegible-next'),
  },
  plex: { label: 'IBM Plex Sans', family: "'IBM Plex Sans Variable', 'Segoe UI', system-ui, sans-serif", load: () => import('@fontsource-variable/ibm-plex-sans') },
  literata: { label: 'Literata', family: "'Literata Variable', Georgia, serif", load: () => import('@fontsource-variable/literata') },
  'source-serif': { label: 'Source Serif', family: "'Source Serif 4 Variable', Cambria, Georgia, serif", load: () => import('@fontsource-variable/source-serif-4') },
  jetbrains: { label: 'JetBrains Mono', family: "'JetBrains Mono Variable', Consolas, ui-monospace, monospace", load: () => import('@fontsource-variable/jetbrains-mono') },
  system: { label: 'System', family: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
}
const SYSTEM_MONO = "ui-monospace, 'Cascadia Mono', Consolas, 'DejaVu Sans Mono', monospace"

export const FONT_CHOICES = {
  ui: ['inter', 'atkinson', 'plex', 'system'] as FontUi[],
  text: ['inter', 'literata', 'source-serif', 'atkinson', 'plex', 'system'] as FontText[],
  code: ['jetbrains', 'system'] as FontCode[],
}

/** The widest line of text: about 70 characters at the normal width. */
export const WIDTHS: Record<Width, string> = { narrow: '36rem', normal: '42rem', wide: '56rem', full: 'none' }

const MODE_KEY = 'nexlore.mode'
let followSystem: (() => void) | null = null

function family(key: string, code = false): string {
  if (code && key === 'system') return SYSTEM_MONO
  const font = FONTS[key as keyof typeof FONTS] ?? FONTS.inter
  void font.load?.()
  return font.family
}

/** Light or dark as chosen; "system" follows the device and changes with it. */
export function applyMode(mode: Mode): void {
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    // The early script then guesses from the last light or dark.
  }
  if (followSystem) {
    followSystem()
    followSystem = null
  }
  const query = window.matchMedia?.('(prefers-color-scheme: light)')
  const resolve = (): Theme => (mode === 'system' ? (query?.matches ? 'light' : 'dark') : mode)
  applyTheme(resolve())
  if (mode === 'system' && query) {
    const changed = () => applyTheme(resolve())
    query.addEventListener('change', changed)
    followSystem = () => query.removeEventListener('change', changed)
  }
}

export function storedMode(): Mode {
  try {
    const mode = localStorage.getItem(MODE_KEY)
    if (mode === 'light' || mode === 'dark' || mode === 'system') return mode
  } catch {
    // Fall through.
  }
  return 'dark'
}

/** Everything but the theme's colours (lib/themes.ts) onto the page. */
export function applyAppearance(look: Appearance): void {
  const root = document.documentElement.style
  root.setProperty('--font-sans', family(look.font_ui))
  root.setProperty('--font-text', family(look.font_text))
  root.setProperty('--font-mono', family(look.font_code, true))
  root.setProperty('--nn-text-size', `${look.size}px`)
  root.setProperty('--nn-width', WIDTHS[look.width] ?? WIDTHS.normal)
  applyMode(look.mode)
}

/** The classes a note asks for in its `cssclasses` property, as Obsidian applies them; only safe names. */
export function noteClasses(front: Record<string, unknown> | null | undefined): string[] {
  const raw = front?.cssclasses ?? front?.cssclass
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : []
  return list.map((item) => String(item).trim()).filter((name) => /^[A-Za-z][\w-]{0,40}$/.test(name)).slice(0, 10)
}
