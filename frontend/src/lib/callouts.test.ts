import { describe, expect, it } from 'vitest'

import { calloutCss, cleanCallouts, defaultCalloutCss, symbolImage } from './callouts'
import { readThemeFile, themeCss } from './themes'

describe('callouts in a theme', () => {
  it('draws a symbol for every kind of Obsidian, the note\'s for the rest', () => {
    const css = defaultCalloutCss()
    expect(css).toContain('.nn-callout, .nx-callout { --nn-callout-icon: url("data:image/svg+xml,')
    expect(css).toContain('.nn-callout-warning, .nx-callout-warning { --nn-callout-icon:')
    expect(symbolImage('alert')).toMatch(/^url\("data:image\/svg\+xml,%3Csvg/)
    expect(symbolImage('no-such-symbol')).toBeNull()
  })

  it('gives a kind its colours for dark and light and its symbol, also below a space', () => {
    const css = calloutCss({ recipe: { dark: '#FF8800', light: '#aa5500', icon: 'cooking' } })
    expect(css).toContain(":root:not([data-theme='light']) .nn-callout-recipe, :root:not([data-theme='light']) .nx-callout-recipe { --nn-callout: #ff8800; --nx-callout: #ff8800; }")
    expect(css).toContain(":root[data-theme='light'] .nn-callout-recipe, :root[data-theme='light'] .nx-callout-recipe { --nn-callout: #aa5500; --nx-callout: #aa5500; }")
    expect(css).toContain(`.nn-callout-recipe, .nx-callout-recipe { --nn-callout-icon: ${symbolImage('cooking')}; }`)
    const below = calloutCss({ recipe: { dark: '#ff8800', icon: 'cooking' } }, '[data-space-theme="t:1"]')
    expect(below).toContain(`:root:not([data-theme='light']) [data-space-theme="t:1"] .nn-callout-recipe`)
    expect(below).toContain('[data-space-theme="t:1"] .nn-callout-recipe, [data-space-theme="t:1"] .nx-callout-recipe { --nn-callout-icon:')
    // Part of the theme's CSS.
    expect(themeCss({ callouts: { recipe: { dark: '#ff8800' } } })).toContain('--nn-callout: #ff8800')
  })

  it('takes only what a theme may hold, and a theme file keeps it', () => {
    expect(cleanCallouts({ Recipe: {}, 'a b': {}, ok: { dark: 'red', light: '#AABBCC', icon: 'nothing-like-it' }, fine: 'x' })).toEqual({ ok: { light: '#aabbcc' } })
    expect(calloutCss({ 'x;} body{': { dark: '#000000' } } as never)).toBe('')
    const file = JSON.stringify({ nexlore_theme: 1, name: 'Kitchen', colours: { dark: { bg: '#101010' }, callouts: { recipe: { icon: 'cooking' } } } })
    expect(readThemeFile(file)?.colours).toEqual({ dark: { bg: '#101010' }, light: undefined, callouts: { recipe: { icon: 'cooking' } } })
  })
})
