import { describe, expect, it } from 'vitest'

import {
  CanvasError,
  EMPTY_CANVAS,
  addEdge,
  addNode,
  bounds,
  colorOf,
  facingSides,
  inGroup,
  makeEdge,
  makeNode,
  nearestSide,
  newId,
  parseCanvas,
  removeEdges,
  removeNodes,
  serializeCanvas,
  titleOf,
  updateEdge,
  updateNodes,
} from './model'

/** Made up for the tests, written the way Obsidian writes a canvas (the backend's tests use the same). */
const WRITTEN = [
  '{',
  '\t"nodes":[',
  '\t\t{"id":"a1b2c3d4e5f60708","type":"group","x":-300,"y":-460,"width":610,"height":200,"label":"Planung"},',
  '\t\t{"id":"0f1e2d3c4b5a6978","type":"file","file":"Projekte/Material.md","x":-280,"y":-200,"width":400,"height":400,"color":"6"},',
  '\t\t{"id":"1122334455667788","type":"text","text":"Größe: 3 × 2,5 m\\n\\n- [[Material]]","x":40,"y":-440,"width":250,"height":160},',
  '\t\t{"id":"99aabbccddeeff00","type":"link","url":"https://example.com/anleitung","x":360,"y":-400,"width":400,"height":80}',
  '\t],',
  '\t"edges":[',
  '\t\t{"id":"e1e2e3e4e5e6e7e8","fromNode":"0f1e2d3c4b5a6978","fromSide":"right","toNode":"1122334455667788","toSide":"left","label":"braucht"}',
  '\t]',
  '}',
].join('\n')

const ODD = [
  '{',
  '\t"type":"canvas",',
  '\t"version":2,',
  '\t"nodes":[',
  '\t\t{"type":"text","text":"Zuerst der Text","id":"5566778899aabbcc","x":0,"y":0,"width":250,"height":60,"styleAttributes":{"shape":"pill"}},',
  '\t\t{"id":"ccbbaa9988776655","x":300,"y":0,"width":250,"height":60,"type":"text","text":"Typ hinten"}',
  '\t],',
  '\t"edges":[]',
  '}',
].join('\n')

const changedLines = (before: string, after: string) => {
  const a = before.split('\n')
  const b = after.split('\n')
  return b.filter((line, index) => line !== a[index]).length + Math.abs(a.length - b.length)
}

describe('writing the way Obsidian writes', () => {
  it.each([['written', WRITTEN], ['odd', ODD], ['empty', '{\n\t"nodes":[],\n\t"edges":[]\n}']])(
    'gives a canvas back byte for byte (%s)',
    (_name, text) => {
      expect(serializeCanvas(parseCanvas(text))).toBe(text)
    },
  )

  it('writes a canvas of another form in Obsidian’s', () => {
    const other = JSON.stringify(JSON.parse(WRITTEN), null, 2) + '\n'
    expect(serializeCanvas(parseCanvas(other))).toBe(WRITTEN)
  })

  it('writes an empty canvas as Obsidian does, and gives one without lists both', () => {
    expect(serializeCanvas(EMPTY_CANVAS)).toBe('{\n\t"nodes":[],\n\t"edges":[]\n}')
    expect(serializeCanvas(parseCanvas(''))).toBe('{\n\t"nodes":[],\n\t"edges":[]\n}')
    expect(serializeCanvas(parseCanvas('{"edges":[]}'))).toBe('{\n\t"edges":[],\n\t"nodes":[]\n}')
  })

  it('reads past a byte order mark', () => {
    expect(parseCanvas(String.fromCharCode(0xfeff) + WRITTEN).nodes).toHaveLength(4)
  })

  it.each([
    ['no JSON', '{nodes: []}'],
    ['a list on top', '[]'],
    ['nodes no list', '{"nodes":{}}'],
    ['edges no list', '{"edges":"x"}'],
    ['a card without id', '{"nodes":[{"type":"text"}]}'],
    ['an empty id', '{"nodes":[{"id":""}]}'],
    ['a card that is no object', '{"nodes":["a"]}'],
  ])('refuses what is no canvas (%s)', (_name, text) => {
    expect(() => parseCanvas(text)).toThrow(CanvasError)
  })
})

describe('changing cards', () => {
  it('changes the one line of the card that changed, keeping the order of its fields', () => {
    const canvas = parseCanvas(WRITTEN)
    const moved = updateNodes(canvas, { '1122334455667788': { x: 55.4, color: '3' } })
    const text = serializeCanvas(moved)
    expect(changedLines(WRITTEN, text)).toBe(1)
    expect(text).toContain('{"id":"1122334455667788","type":"text","text":"Größe: 3 × 2,5 m\\n\\n- [[Material]]","x":55,"y":-440,"width":250,"height":160,"color":"3"}')
    // The old canvas stays as it was (going back is keeping it).
    expect(serializeCanvas(canvas)).toBe(WRITTEN)
  })

  it('takes a field away with undefined, and gives the same canvas when nothing changes', () => {
    const canvas = parseCanvas(WRITTEN)
    const plain = updateNodes(canvas, { '0f1e2d3c4b5a6978': { color: undefined } })
    expect(plain.nodes[1]).not.toHaveProperty('color')
    expect(updateNodes(canvas, { '0f1e2d3c4b5a6978': { x: -280 } })).toBe(canvas)
    expect(updateNodes(canvas, { unknown: { x: 1 } })).toBe(canvas)
  })

  it('keeps what the format does not name', () => {
    const canvas = parseCanvas(ODD)
    const text = serializeCanvas(updateNodes(canvas, { ccbbaa9988776655: { text: 'neu' } }))
    expect(text).toContain('"styleAttributes":{"shape":"pill"}')
    expect(text.startsWith('{\n\t"type":"canvas",\n\t"version":2,\n')).toBe(true)
    expect(text).toContain('{"id":"ccbbaa9988776655","x":300,"y":0,"width":250,"height":60,"type":"text","text":"neu"}')
  })

  it('makes a new card in Obsidian’s order, a whole pixel at a time', () => {
    const canvas = parseCanvas(WRITTEN)
    const text = makeNode(canvas, { type: 'text', text: 'Hallo' }, { x: 1.6, y: 2.2, width: 250, height: 60.5 })
    expect(Object.keys(text)).toEqual(['id', 'type', 'text', 'x', 'y', 'width', 'height'])
    expect([text.x, text.y, text.height]).toEqual([2, 2, 61])
    const file = makeNode(canvas, { type: 'file', file: 'Projekte/Material.md', subpath: '#Holz' }, { x: 0, y: 0, width: 1, height: 1 })
    expect(Object.keys(file)).toEqual(['id', 'type', 'file', 'subpath', 'x', 'y', 'width', 'height'])
    const whole = makeNode(canvas, { type: 'file', file: 'Bild.png' }, { x: 0, y: 0, width: 1, height: 1 })
    expect(Object.keys(whole)).toEqual(['id', 'type', 'file', 'x', 'y', 'width', 'height'])
    const group = makeNode(canvas, { type: 'group', label: 'Planung' }, { x: 0, y: 0, width: 1, height: 1 })
    expect(Object.keys(group)).toEqual(['id', 'type', 'x', 'y', 'width', 'height', 'label'])
    expect(Object.keys(makeNode(canvas, { type: 'group' }, { x: 0, y: 0, width: 1, height: 1 }))).toEqual(['id', 'type', 'x', 'y', 'width', 'height'])
  })

  it('puts a new group below every card and any other card on top', () => {
    const canvas = parseCanvas(WRITTEN)
    const group = makeNode(canvas, { type: 'group', label: 'Neu' }, { x: 0, y: 0, width: 10, height: 10 })
    const card = makeNode(canvas, { type: 'text', text: 'oben' }, { x: 0, y: 0, width: 10, height: 10 })
    expect(addNode(canvas, group).nodes[0]).toBe(group)
    expect(addNode(canvas, card).nodes.at(-1)).toBe(card)
  })

  it('takes the lines of a removed card along', () => {
    const canvas = parseCanvas(WRITTEN)
    const without = removeNodes(canvas, ['1122334455667788'])
    expect(without.nodes.map((node) => node.id)).toEqual(['a1b2c3d4e5f60708', '0f1e2d3c4b5a6978', '99aabbccddeeff00'])
    expect(without.edges).toEqual([])
    expect(removeNodes(canvas, ['none'])).toBe(canvas)
  })
})

describe('lines', () => {
  it('makes a line in Obsidian’s order and writes only the ends that differ from the defaults', () => {
    const canvas = parseCanvas(WRITTEN)
    const edge = makeEdge(canvas, { node: 'a', side: 'bottom' }, { node: 'b', side: 'top' })
    expect(Object.keys(edge)).toEqual(['id', 'fromNode', 'fromSide', 'toNode', 'toSide'])
    expect(Object.keys(makeEdge(canvas, { node: 'a' }, { node: 'b' }))).toEqual(['id', 'fromNode', 'toNode'])
    const both = updateEdge(addEdge(canvas, edge), edge.id, { fromEnd: 'arrow', label: 'und' })
    expect(Object.keys(both.edges.at(-1)!)).toEqual(['id', 'fromNode', 'fromSide', 'toNode', 'toSide', 'fromEnd', 'label'])
    expect(removeEdges(both, [edge.id]).edges).toHaveLength(1)
    expect(updateEdge(canvas, 'e1e2e3e4e5e6e7e8', { label: 'braucht' })).toBe(canvas)
  })

  it('ends a line let go on a card at the side nearest the pointer', () => {
    const box = { left: 100, top: 100, right: 400, bottom: 190 }
    expect(nearestSide(box, 250, 185)).toBe('bottom')
    expect(nearestSide(box, 250, 104)).toBe('top')
    expect(nearestSide(box, 110, 150)).toBe('left')
    expect(nearestSide(box, 395, 120)).toBe('right')
  })

  it('lets two cards that do not say face each other', () => {
    const a = { x: 0, y: 0, width: 100, height: 100 }
    expect(facingSides(a, { x: 300, y: 20, width: 100, height: 100 })).toEqual(['right', 'left'])
    expect(facingSides(a, { x: -300, y: 20, width: 100, height: 100 })).toEqual(['left', 'right'])
    expect(facingSides(a, { x: 20, y: 300, width: 100, height: 100 })).toEqual(['bottom', 'top'])
    expect(facingSides(a, { x: 20, y: -300, width: 100, height: 100 })).toEqual(['top', 'bottom'])
  })
})

describe('groups, bounds, colours, ids', () => {
  it('holds in a group what lies wholly inside it', () => {
    const canvas = parseCanvas(WRITTEN)
    const group = { id: 'g', x: -300, y: -460, width: 1100, height: 700 }
    // A group inside a group goes with it.
    expect(inGroup(canvas, group).map((node) => node.id)).toEqual([
      'a1b2c3d4e5f60708', '0f1e2d3c4b5a6978', '1122334455667788', '99aabbccddeeff00',
    ])
    expect(inGroup(canvas, { ...group, width: 300 }).map((node) => node.id)).toEqual([])
    // "Planung" holds the text card that lies in it, not the file card that reaches out below it.
    expect(inGroup(canvas, canvas.nodes[0]).map((node) => node.id)).toEqual(['1122334455667788'])
    // A card that ends exactly on the edge lies in it; one that starts inside and reaches out does not.
    const edges = { ...canvas, nodes: [
      { id: 'flush', type: 'text', x: 10, y: 10, width: 90, height: 90 },
      { id: 'out', type: 'text', x: 10, y: 50, width: 50, height: 60 },
    ] }
    expect(inGroup(edges, { id: 'g', x: 0, y: 0, width: 100, height: 100 }).map((node) => node.id)).toEqual(['flush'])
  })

  it('gives the box around every card', () => {
    expect(bounds([])).toBeNull()
    expect(bounds(parseCanvas(WRITTEN).nodes)).toEqual({ x: -300, y: -460, width: 1060, height: 660 })
  })

  it('turns the six presets into the canvas’s colours and keeps a colour of its own', () => {
    expect(colorOf('4')).toBe('var(--canvas-color-4)')
    expect(colorOf('#ff8800')).toBe('#ff8800')
    expect(colorOf('#f80')).toBe('#f80')
    expect(colorOf('7')).toBeNull()
    expect(colorOf('red; background: url(x)')).toBeNull()
    expect(colorOf('#fff; background: url(x)')).toBeNull()
    expect(colorOf('url(x) #ffffff')).toBeNull()
    expect(colorOf(undefined)).toBeNull()
  })

  it('gives far out a title of plain words', () => {
    const text = (body: string) => titleOf({ id: 'a', type: 'text', x: 0, y: 0, width: 1, height: 1, text: body })
    expect(text('**Offen:** Wer leiht uns den [[Werkzeug|Rüttler]]?\n\nmehr')).toBe('Offen: Wer leiht uns den Rüttler?')
    expect(text('## Ziel\n\nbis Mai')).toBe('Ziel')
    expect(text('- [ ] `Holz` ==bestellen==')).toBe('Holz bestellen')
    expect(titleOf({ id: 'b', type: 'file', file: 'Projekte/Material.md', x: 0, y: 0, width: 1, height: 1 })).toBe('Material')
    expect(titleOf({ id: 'c', type: 'link', url: 'https://example.com/a', x: 0, y: 0, width: 1, height: 1 })).toBe('example.com')
    expect(titleOf({ id: 'd', type: 'group', label: 'Planung', x: 0, y: 0, width: 1, height: 1 })).toBe('Planung')
  })

  it('makes ids of 16 hex digits, none the canvas has', () => {
    const canvas = parseCanvas(WRITTEN)
    const ids = new Set(Array.from({ length: 200 }, () => newId(canvas)))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/)
  })
})
