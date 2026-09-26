import { linkIndex } from './links'
import { buildVault, noteFromPath } from './vault'

const vault = buildVault(
  [
    noteFromPath(1, 'Work/Plan.md', 'Plan'),
    noteFromPath(2, 'Work/Ideas/Garden.md', 'Garden'),
    noteFromPath(3, 'Work/Other/Garden.md', 'Garden'),
    noteFromPath(4, 'Work/Ideas/Plan.md', 'Plan in ideas'),
    noteFromPath(5, 'Home/Garden.md', 'Garden at home'),
  ],
  [],
)

describe('wiki links in the editor', () => {
  it("resolve like Obsidian: same folder first, then the shortest path, never across spaces", () => {
    const fromIdeas = linkIndex(vault, 'Work/Ideas/Note.md')
    expect(fromIdeas.resolve('Plan')).toBe('Work/Ideas/Plan.md')
    expect(fromIdeas.resolve('plan.md')).toBe('Work/Ideas/Plan.md')
    expect(linkIndex(vault, 'Work/Note.md').resolve('Plan')).toBe('Work/Plan.md')
    expect(fromIdeas.resolve('Other/Garden')).toBe('Work/Other/Garden.md')
    expect(fromIdeas.resolve('Work/Other/Garden')).toBe('Work/Other/Garden.md')
    expect(linkIndex(vault, 'Home/Note.md').resolve('Plan')).toBeNull()
    expect(fromIdeas.resolve('Plan#Heading')).toBe('Work/Ideas/Plan.md')
    expect(fromIdeas.resolve('#Heading')).toBe('Work/Ideas/Note.md')
  })

  it('count files other than notes as there, and a missing note as missing', () => {
    const index = linkIndex(vault, 'Work/Plan.md')
    expect(index.exists('diagram.png')).toBe(true)
    expect(index.exists('Nowhere')).toBe(false)
  })

  it('suggest the name, or the path where names repeat', () => {
    const inserts = linkIndex(vault, 'Work/Plan.md').suggestions.map((item) => item.insert)
    expect(inserts).toContain('Ideas/Garden')
    expect(inserts).toContain('Other/Garden')
    expect(inserts).not.toContain('Garden')
    expect(inserts.filter((insert) => insert.includes('home'))).toEqual([])
  })
})
