import { describe, expect, it } from 'vitest'

import { targetOf, vaultPath, writtenPath } from './context'

describe('a card’s path and the vault', () => {
  it('reads a card’s path from the top of its space', () => {
    expect(vaultPath('Haus', 'Projekte/Material.md')).toBe('Haus/Projekte/Material.md')
    expect(vaultPath('Haus', '/Projekte/Material.md')).toBe('Haus/Projekte/Material.md')
  })

  it('takes a path Obsidian wrote on the whole vault, with the space in front, as it is', () => {
    expect(vaultPath('Haus', 'Haus/Projekte/Material.md')).toBe('Haus/Projekte/Material.md')
    expect(vaultPath('Haus', 'haus/Material.md')).toBe('Haus/Material.md')
    // A folder that only starts like the space is a folder.
    expect(vaultPath('Haus', 'Hausbau/Plan.md')).toBe('Haus/Hausbau/Plan.md')
  })

  it('writes a vault path from the top of the space, as Obsidian writes a card', () => {
    expect(writtenPath('Haus', 'Haus/Projekte/Material.md')).toBe('Projekte/Material.md')
    expect(writtenPath('Haus', 'Garten/Beet.md')).toBe('Garten/Beet.md')
  })
})

describe('where a card leads', () => {
  const targets = { cards: { 'Garten/Beete.md': 'Garten/Beete.md', 'Fehlt.md': null, 'Geheim/Plan.md': null }, locked: new Set(['Geheim/Plan.md']) }
  it('goes where the server found it, into another space too', () => {
    expect(targetOf('Haus', targets, new Map(), 'Garten/Beete.md')).toEqual({ path: 'Garten/Beete.md', locked: false })
  })
  it('is locked where the server says so, and missing where it found nothing', () => {
    expect(targetOf('Haus', targets, new Map(), 'Geheim/Plan.md')).toEqual({ path: 'Haus/Geheim/Plan.md', locked: true })
    expect(targetOf('Haus', targets, new Map(), 'Fehlt.md')).toEqual({ path: 'Haus/Fehlt.md', locked: false })
  })
  it('a card laid down since leads where it came from, else from the top of the space', () => {
    const placed = new Map([['Garten/Neu.md', 'Garten/Neu.md']])
    expect(targetOf('Haus', targets, placed, 'Garten/Neu.md')).toEqual({ path: 'Garten/Neu.md', locked: false })
    expect(targetOf('Haus', targets, placed, 'Projekte/Neu.md')).toEqual({ path: 'Haus/Projekte/Neu.md', locked: false })
  })
})
