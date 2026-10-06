/** Languages the operator adds on the server: offered, loaded, incomplete ones fall back to English. */

import i18n, { changeLanguage, languageOptions, resetAddedLanguages, startI18n, templateFile } from './index'
import en from './en.json'

type Routes = Record<string, unknown>

function serve(routes: Routes): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (!(url in routes)) return new Response('{"detail":{"code":"not_found"}}', { status: 404 })
    const body = routes[url]
    if (body instanceof Error) throw body
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Node brings a localStorage of its own that shadows jsdom's and cannot clear; a plain one in memory instead. */
function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  }
}

beforeEach(async () => {
  resetAddedLanguages()
  vi.stubGlobal('localStorage', memoryStorage())
  for (const code of ['es', 'de', 'fr']) i18n.removeResourceBundle?.(code, 'translation')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('added languages', () => {
  it('are offered next to the shipped ones, with their own name', async () => {
    serve({ '/api/locales': [{ code: 'es', name: 'Español', keys: 2 }] })
    expect(await languageOptions()).toEqual([
      { code: 'de', name: 'Deutsch', added: false },
      { code: 'en', name: 'English', added: false },
      { code: 'es', name: 'Español', added: true },
    ])
  })

  it('take their place by name among the shipped ones, not at the end (decided 06.10.2026)', async () => {
    serve({
      '/api/locales': [
        { code: 'fr', name: 'Français', keys: 1 },
        { code: 'af', name: 'Afrikaans', keys: 1 },
        { code: 'es', name: 'Español', keys: 1 },
      ],
    })
    expect((await languageOptions()).map((option) => option.name)).toEqual(['Afrikaans', 'Deutsch', 'English', 'Español', 'Français'])
  })

  it('fall back to English for every key they leave out', async () => {
    serve({
      '/api/locales': [{ code: 'es', name: 'Español', keys: 1 }],
      '/api/locales/es': { nav: { graph: 'Grafo' } },
    })
    await startI18n()
    await changeLanguage('es')
    expect(i18n.language).toBe('es')
    expect(i18n.t('nav.graph')).toBe('Grafo')
    expect(i18n.t('nav.notes')).toBe(en.nav.notes)
    expect(document.documentElement.lang).toBe('es')
    expect(localStorage.getItem('nexlore.language')).toBe('es')
  })

  it('are chosen again at the next start', async () => {
    serve({
      '/api/locales': [{ code: 'es', name: 'Español', keys: 1 }],
      '/api/locales/es': { nav: { graph: 'Grafo' } },
    })
    localStorage.setItem('nexlore.language', 'es')
    await startI18n()
    expect(i18n.language).toBe('es')
    expect(i18n.t('nav.graph')).toBe('Grafo')
  })

  it('an operator file for a shipped language is laid over its texts', async () => {
    serve({
      '/api/locales': [{ code: 'de', name: 'Deutsch', keys: 1 }],
      '/api/locales/de': { nav: { files: 'Anhänge' } },
    })
    await startI18n()
    await changeLanguage('de')
    expect(i18n.t('nav.files')).toBe('Anhänge')
    expect(i18n.t('nav.notes')).toBe('Notizen')
  })

  it('a language the server no longer has is not switched to', async () => {
    serve({ '/api/locales': [] })
    await startI18n()
    await changeLanguage('fr')
    expect(i18n.language).toBe('en')
  })

  it('a stored language that is gone starts in English', async () => {
    serve({ '/api/locales': [] })
    localStorage.setItem('nexlore.language', 'fr')
    await startI18n()
    expect(i18n.language).toBe('en')
    expect(i18n.t('nav.notes')).toBe(en.nav.notes)
  })

  it('without a server the app still starts, with the shipped languages', async () => {
    serve({ '/api/locales': new TypeError('Failed to fetch') })
    await startI18n()
    expect(i18n.t('nav.notes')).toBe(en.nav.notes)
    expect((await languageOptions()).map((option) => option.code)).toEqual(['de', 'en'])
  })

  it('codes that are not language codes are ignored, and never asked for', async () => {
    const fetchMock = serve({ '/api/locales': [{ code: '../secret', name: 'x', keys: 1 }, { code: 'es', name: 'Español', keys: 1 }] })
    expect((await languageOptions()).map((option) => option.code)).toEqual(['de', 'en', 'es'])
    await changeLanguage('../secret')
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain('/api/locales/../secret')
  })
})

describe('the template', () => {
  it('is the English texts plus the _meta entry for the name', async () => {
    const text = await templateFile().text()
    const template = JSON.parse(text)
    expect(template._meta).toEqual({ name: expect.any(String) })
    const { _meta, ...rest } = template
    expect(_meta).toBeTruthy()
    expect(rest).toEqual(en)
    expect(text.endsWith('\n')).toBe(true)
  })
})
