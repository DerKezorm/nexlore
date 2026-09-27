import type { NoteData } from '../api/client'
import { pluginText, viewFor, type PluginInfo } from './registry'

function plugin(id: string, place: PluginInfo['place']): PluginInfo {
  return { id, version: '1.0.0', author: 'nexlore', name: { en: id }, description: { en: '' }, permissions: [], place, strings: {}, source: 'catalog', enabled: true }
}

const note = (front: unknown) => ({ path: 'S/n.md', title: 'n', content: '', hash: 'h', front }) as unknown as NoteData

describe('plugins of an account', () => {
  it('speak the interface language, else its base language, else English', () => {
    const texts = { en: 'Contents', de: 'Inhaltsverzeichnis' }
    expect(pluginText(texts, 'de')).toBe('Inhaltsverzeichnis')
    expect(pluginText(texts, 'de-AT')).toBe('Inhaltsverzeichnis')
    expect(pluginText(texts, 'es')).toBe('Contents')
    expect(pluginText({}, 'de')).toBe('')
  })

  it('take the reading view only for notes with their front matter key', () => {
    const kanban = plugin('kanban', { view: { frontmatter: 'kanban-plugin' } })
    const list = [plugin('toc', { panel: true }), kanban]
    expect(viewFor(list, note({ 'kanban-plugin': 'basic' }))).toBe(kanban)
    expect(viewFor(list, note({ tags: ['x'] }))).toBeNull()
    expect(viewFor(list, note(null))).toBeNull()
    expect(viewFor(list, note('kanban-plugin'))).toBeNull()
  })
})
