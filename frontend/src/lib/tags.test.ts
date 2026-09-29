import { tagTree } from './tags'

describe('tagTree', () => {
  it('puts nested tags under their parent, adds up the counts and sorts by name', () => {
    const tree = tagTree([
      { tag: 'project/garden', count: 2 },
      { tag: 'idea', count: 5 },
      { tag: 'project', count: 1 },
      { tag: 'Project/Kitchen', count: 3 },
      { tag: 'area/home/roof', count: 1 },
    ])
    expect(tree.map((node) => [node.name, node.tag, node.own, node.total])).toEqual([
      ['area', 'area', 0, 1],
      ['idea', 'idea', 5, 5],
      ['project', 'project', 1, 6],
    ])
    const project = tree[2]
    expect(project.children.map((node) => [node.name, node.tag, node.total])).toEqual([
      ['garden', 'project/garden', 2],
      ['Kitchen', 'project/Kitchen', 3],
    ])
    expect(tree[0].children[0].children[0].tag).toBe('area/home/roof')
  })
})
