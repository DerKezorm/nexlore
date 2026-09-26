import { describe, expect, it } from 'vitest'

import { fileKind, formatSize, isPasted, relativeTarget } from './files'

describe('relativeTarget', () => {
  it('finds a file next to the note, escaped the way Markdown links are', () => {
    expect(relativeTarget('Home/Shopping.md', 'Anh%C3%A4nge/Shopping%201.png')).toBe('Home/Anhänge/Shopping 1.png')
    expect(relativeTarget('Home/Shopping.md', 'Anhänge/a b.png')).toBe('Home/Anhänge/a b.png')
    expect(relativeTarget('Home/Recipes/Cake.md', '../Anhänge/x.png')).toBe('Home/Anhänge/x.png')
    expect(relativeTarget('Home/Recipes/Cake.md', './pic.png#part')).toBe('Home/Recipes/pic.png')
    expect(relativeTarget('Home/Recipes/Cake.md', '/Anhänge/x.png')).toBe('Home/Anhänge/x.png')
  })

  it('never leaves the space and leaves web addresses alone', () => {
    expect(relativeTarget('Home/Shopping.md', '../Work/x.png')).toBeNull()
    expect(relativeTarget('Home/Shopping.md', 'https://example.com/x.png')).toBeNull()
    expect(relativeTarget('Home/Shopping.md', 'data:image/png;base64,AAAA')).toBeNull()
    expect(relativeTarget('Home/Shopping.md', '#heading')).toBeNull()
    expect(relativeTarget('Home/Shopping.md', '%E0%A4%A')).toBe('Home/%E0%A4%A')
  })
})

describe('files', () => {
  it('tells kinds by ending', () => {
    expect(['a.PNG', 'b.webp', 'c.mp4', 'd.m4a', 'e.pdf', 'f.heic', 'g.svg'].map(fileKind)).toEqual([
      'image', 'image', 'video', 'audio', 'pdf', 'other', 'other',
    ])
  })

  it('knows a pasted picture by its missing name', () => {
    expect([{ name: 'image.png' }, { name: '' }, { name: 'IMG_0001.jpg' }].map(isPasted)).toEqual([true, true, false])
  })

  it('writes sizes for people', () => {
    expect(formatSize(512, 'en')).toBe('512 B')
    expect(formatSize(1536, 'en')).toBe('1.5 KB')
    expect(formatSize(700 * 1024 * 1024, 'en')).toBe('700 MB')
  })
})
