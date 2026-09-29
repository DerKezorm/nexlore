import { readThemeFile, spaceScope, themeCss, themeFile, weakSpots } from './themes'

describe('themeCss', () => {
  it('sets the colours given, mixes the shades between two that are there, and nothing for the rest', () => {
    const css = themeCss({ dark: { bg: '#101010', text: '#f0f0f0', 'text-muted': '#909090', accent: '#ff8800' } })
    expect(css).toContain(":root:not([data-theme='light']) {")
    expect(css).toContain('--color-ink-950: #101010;')
    expect(css).toContain('--color-accent-500: #ff8800;')
    expect(css).toContain('--color-mist-300: color-mix(in srgb, #f0f0f0 60%, #909090);')
    expect(css).toContain('--color-accent-600: color-mix(in srgb, #ff8800 85%, #101010);')
    expect(css).not.toContain(":root[data-theme='light']")
    expect(css).not.toContain('--color-ink-900')
    expect(themeCss(null)).toBe('')
  })
  it('scopes a space theme under its notes and paints their ground', () => {
    const css = themeCss({ light: { bg: '#ffffff' } }, spaceScope('t:12'))
    expect(css).toContain(`:root[data-theme='light'] [data-space-theme="t:12"] {`)
    expect(css).toContain('[data-space-theme="t:12"] { background: var(--color-ink-950);')
    expect(spaceScope('bad"] body {x')).toBe('[data-space-theme="badbodyx"]')
  })
  it('drops what is not a colour, whatever a file says', () => {
    expect(themeCss({ dark: { bg: 'red; } body { background: url(x)' } as never })).toBe('')
  })
})

describe('theme files', () => {
  it('go out and come in again, and take nexdeck’s without its grey for unknown states', () => {
    const colours = { dark: { accent: '#ff8800' }, light: { accent: '#aa5500' } }
    expect(readThemeFile(themeFile('Dusk', colours))).toEqual({ name: 'Dusk', colours })
    const nexdeck = JSON.stringify({ nexdeck_theme: 1, name: 'Plum', dark: { accent: '#E879F9', unknown: '#9d8ea9', glow: '#000000' } })
    expect(readThemeFile(nexdeck)).toEqual({ name: 'Plum', colours: { dark: { accent: '#e879f9' }, light: undefined } })
    expect(readThemeFile('not json')).toBeNull()
    expect(readThemeFile('{"name": "x"}')).toBeNull()
  })
})

describe('weakSpots', () => {
  it('finds text below 4.5:1 on a ground as the server does', () => {
    expect(weakSpots({ dark: { bg: '#777777', text: '#888888' } })).toEqual([{ mode: 'dark', token: 'text', ratio: 1.26 }])
    expect(weakSpots({ light: { accent: '#ffff00', 'on-accent': '#ffffff' } })).toEqual([
      { mode: 'light', token: 'on-accent', ratio: 1.07 },
    ])
  })
})
