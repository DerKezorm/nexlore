import { distinctOutgoing, LinkIndex, linkedSpace, linkName, type Asker } from './links'

/** A server that knows a few notes of the space `Work`, as `index.resolve` would answer from `Work/Ideas/Note.md`. */
function fakeServer(): Asker & { asked: string[][] } {
  const where: Record<string, string> = {
    plan: 'Work/Ideas/Plan.md',
    'other/garden': 'Work/Other/Garden.md',
    'diagram.png': 'Work/Attachments/diagram.png',
  }
  const asked: string[][] = []
  return {
    asked,
    resolveMany: async (_source, targets) => {
      asked.push(targets)
      return { found: Object.fromEntries(targets.map((target) => [target, where[target.toLowerCase()] ?? null])) }
    },
    find: async (q) =>
      q === 'gar'
        ? [
            { path: 'Work/Ideas/Garden.md', title: 'Garden', link: 'Garden' },
            { path: 'Work/Other/Garden.md', title: 'Garden', link: 'Other/Garden' },
            { path: 'Homelab/Garden shed.md', title: 'Garden shed', link: 'Homelab/Garden shed' },
            { path: 'Work/Plants.md', title: 'Plants', link: 'Plants', alias: 'Gardening' },
          ]
        : [],
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 200))

describe('wiki links in the editor, answered by the server', () => {
  it('take the note part of a target', () => {
    expect(linkName('Plan#Heading|Alias')).toBe('Plan')
    expect(linkName('  Folder/Note  ')).toBe('Folder/Note')
    expect(linkName('#Only heading')).toBe('')
  })

  it('count an unknown link as there until the server answers, then draw again', async () => {
    const server = fakeServer()
    let drawn = 0
    const index = new LinkIndex('Work/Ideas/Note.md', () => drawn++, server)
    expect(index.exists('Nowhere')).toBe(true)
    expect(index.exists('Plan#Part')).toBe(true)
    expect(index.resolve('#Heading')).toBe('Work/Ideas/Note.md')
    await settle()
    // Both asked in one request.
    expect(server.asked).toEqual([['Nowhere', 'Plan']])
    expect(drawn).toBe(1)
    expect(index.exists('Nowhere')).toBe(false)
    expect(index.exists('nowhere')).toBe(false)
    expect(index.resolve('plan')).toBe('Work/Ideas/Plan.md')
  })

  it('know the saved links at once, and leave pictures to the editor', async () => {
    const server = fakeServer()
    const index = new LinkIndex('Work/Ideas/Note.md', () => undefined, server)
    index.seed([
      { kind: 'wiki', target: 'Plan', subpath: '', line: 1, path: 'Work/Ideas/Plan.md', title: 'Plan' },
      { kind: 'wiki', target: 'Gone', subpath: '', line: 2, path: null, title: null },
      { kind: 'embed', target: 'diagram.png', subpath: '', line: 3, path: 'Work/Attachments/diagram.png', title: null },
      { kind: 'md', target: 'x.md', subpath: '', line: 4, path: 'Work/x.md', title: 'x' },
    ])
    expect(index.resolve('Plan')).toBe('Work/Ideas/Plan.md')
    expect(index.exists('Gone')).toBe(false)
    // A picture is not a note: resolved to nothing here, still there as a file.
    expect(index.resolve('diagram.png')).toBeNull()
    expect(index.exists('diagram.png')).toBe(true)
    await settle()
    expect(server.asked).toEqual([])
  })

  it('ask the server on every click, never trusting an old "nothing there"', async () => {
    const server = fakeServer()
    const index = new LinkIndex('Work/Ideas/Note.md', () => undefined, server)
    expect(await index.resolveNow('Other/Garden|Alias')).toBe('Work/Other/Garden.md')
    expect(await index.resolveNow('Nowhere')).toBeNull()
    expect(server.asked).toEqual([['Other/Garden'], ['Nowhere']])
    // Made elsewhere in the meantime: the next click finds it and makes no second note.
    const later: Asker = { ...server, resolveMany: async () => ({ found: { Nowhere: 'Work/Nowhere.md' } }) }
    const again = new LinkIndex('Work/Ideas/Note.md', () => undefined, later)
    again.seed([{ kind: 'wiki', target: 'Nowhere', subpath: '', line: 1, path: null, title: null }])
    expect(again.exists('Nowhere')).toBe(false)
    expect(await again.resolveNow('Nowhere')).toBe('Work/Nowhere.md')
    expect(again.exists('Nowhere')).toBe(true)
    const failing = new LinkIndex('Work/Ideas/Note.md', () => undefined, {
      ...server,
      resolveMany: () => Promise.reject(new Error('offline')),
    })
    await expect(failing.resolveNow('Plan')).rejects.toThrow('offline')
  })

  it('suggest what the server found, with the link text it says reaches each note', async () => {
    let drawn = 0
    const index = new LinkIndex('Work/Ideas/Note.md', () => drawn++, fakeServer())
    expect(index.search('gar')).toEqual([])
    await settle()
    expect(drawn).toBe(1)
    expect(index.search('gar')).toEqual([
      { label: 'Garden', detail: 'Ideas/Garden', insert: 'Garden' },
      { label: 'Garden', detail: 'Other/Garden', insert: 'Other/Garden' },
      // A note of another space: shown and linked with that space's name in front.
      { label: 'Garden shed', detail: 'Homelab/Garden shed', insert: 'Homelab/Garden shed' },
      // Found by an alias: shown under it, linked with it as the text.
      { label: 'Gardening', detail: 'Plants · Plants', insert: 'Plants|Gardening' },
    ])
    // What a suggestion inserts is known to lead there.
    expect(index.resolve('Other/Garden')).toBe('Work/Other/Garden.md')
  })

  it('ask again after a while about a link that led nowhere', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const server = fakeServer()
      const index = new LinkIndex('Work/Ideas/Note.md', () => undefined, server)
      index.seed([{ kind: 'wiki', target: 'Gone', subpath: '', line: 1, path: null, title: null }])
      expect(index.exists('Gone')).toBe(false)
      await settle()
      expect(server.asked).toEqual([])
      vi.setSystemTime(Date.now() + 31_000)
      expect(index.exists('Gone')).toBe(false)
      await settle()
      expect(server.asked).toEqual([['Gone']])
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop asking once closed', async () => {
    const server = fakeServer()
    let drawn = 0
    const index = new LinkIndex('Work/Ideas/Note.md', () => drawn++, server)
    index.exists('Plan')
    index.close()
    await settle()
    expect(drawn).toBe(0)
  })
})

describe('a link that names another space in front', () => {
  const spaces = [
    { name: 'Work', role: 'manage' },
    { name: 'Homelab', role: 'write' },
    { name: 'Reading', role: 'read' },
  ]

  it('says which space and what is left, without case', () => {
    expect(linkedSpace('Homelab/Why ZFS', spaces, 'Work')).toEqual({ space: 'Homelab', role: 'write', rest: 'Why ZFS' })
    expect(linkedSpace('homelab/Pools/ZFS#Why|so', spaces, 'Work')).toEqual({ space: 'Homelab', role: 'write', rest: 'Pools/ZFS' })
    expect(linkedSpace('/Reading/Book', spaces, 'Work')?.role).toBe('read')
  })

  it('is nothing for the own space, a plain name, or a space the account does not know', () => {
    expect(linkedSpace('Work/Plan', spaces, 'Work')).toBeNull()
    expect(linkedSpace('Plan', spaces, 'Work')).toBeNull()
    expect(linkedSpace('Homelab/', spaces, 'Work')).toBeNull()
    expect(linkedSpace('Secret/Plan', spaces, 'Work')).toBeNull()
  })
})

describe('distinctOutgoing', () => {
  const link = (target: string, path: string | null, line = 1) => ({ kind: 'wiki', target, subpath: '', line, path, title: path })
  it('lists each place once, in the order of the first link, with how often the note links there', () => {
    const list = distinctOutgoing([
      link('Welcome', 'Guide/Welcome.md', 1),
      link('Map', 'Guide/Map.md', 2),
      link('Welcome#Start', 'Guide/Welcome.md', 3),
      link('Welcome|home', 'Guide/Welcome.md', 4),
    ])
    expect(list.map(({ link, count }) => [link.path, count, link.line])).toEqual([
      ['Guide/Welcome.md', 3, 1],
      ['Guide/Map.md', 1, 2],
    ])
  })
  it('counts a missing link by the name it asks for, whatever heading, alias or case it carries', () => {
    const list = distinctOutgoing([link('Someday', null), link('someday#Later', null), link('Someday|one day', null), link('Other', null)])
    expect(list.map(({ link, count }) => [link.target, count])).toEqual([['Someday', 3], ['Other', 1]])
  })
})
