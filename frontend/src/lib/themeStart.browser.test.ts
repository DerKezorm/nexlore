/**
 * A new theme starts from nexlore's own colours: the values in lib/themes.ts must be those of styles/index.css, in
 * both modes. They drifted once (block U changed the CSS, a new theme then brought the old, weaker greys back).
 */
import { describe, expect, it } from 'vitest'
import css from '../styles/index.css?raw'
import { NEXLORE_COLOURS } from './themes'

/** The custom properties of the first block that starts with `opening`. */
function block(opening: string): Record<string, string> {
  const start = css.indexOf(opening)
  expect(start).toBeGreaterThanOrEqual(0)
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start))
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((found) => [found[1], found[2].trim().toLowerCase()]))
}

const WHERE = {
  bg: '--color-ink-950',
  'bg-elev': '--color-ink-900',
  surface: '--color-ink-850',
  'surface-hover': '--color-ink-800',
  border: '--color-ink-700',
  'border-strong': '--color-ink-600',
  text: '--color-mist-100',
  'text-muted': '--color-mist-500',
  'text-faint': '--color-mist-600',
  accent: '--color-accent-500',
  'on-accent': '--color-on-accent',
} as const

describe('the start of a new theme', () => {
  const dark = block('@theme {')
  const light = { ...dark, ...block(":root[data-theme='light'] {") }
  for (const [mode, tokens] of [['dark', dark], ['light', light]] as const) {
    it(`is nexlore's own ${mode} colours`, () => {
      const shown = Object.fromEntries(Object.entries(WHERE).map(([token, name]) => [token, tokens[name]]))
      const start = Object.fromEntries(Object.keys(WHERE).map((token) => [token, NEXLORE_COLOURS[mode][token as keyof typeof WHERE].toLowerCase()]))
      expect(start).toEqual(shown)
    })
  }
})
