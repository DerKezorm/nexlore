import { LinkIndex, linkName, type Asker } from './links'

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

  it('wait for the server when a click must know where a link leads', async () => {
    const server = fakeServer()
    const index = new LinkIndex('Work/Ideas/Note.md', () => undefined, server)
    expect(await index.resolveNow('Other/Garden|Alias')).toBe('Work/Other/Garden.md')
    expect(await index.resolveNow('Nowhere')).toBeNull()
    expect(server.asked).toEqual([['Other/Garden'], ['Nowhere']])
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
    ])
    // What a suggestion inserts is known to lead there.
    expect(index.resolve('Other/Garden')).toBe('Work/Other/Garden.md')
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
