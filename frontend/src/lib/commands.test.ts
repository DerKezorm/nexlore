import { matchCommands, recentCommands, rememberCommand, type Command } from './commands'

const command = (id: string, label: string, group = 'App'): Command => ({ id, label, group, run: () => {} })
const list = [
  command('go.graph', 'Go to Graph'),
  command('note.edit', 'Edit the note', 'Note'),
  command('editor.bold', 'Bold', 'Editor'),
  command('go.calendar', 'Go to Calendar'),
]

describe('matchCommands', () => {
  it('keeps what has every word in its name or group, starting ones first', () => {
    expect(matchCommands(list, 'go', []).map((c) => c.id)).toEqual(['go.graph', 'go.calendar'])
    expect(matchCommands(list, 'editor', []).map((c) => c.id)).toEqual(['editor.bold'])
    expect(matchCommands(list, 'to cal', []).map((c) => c.id)).toEqual(['go.calendar'])
    expect(matchCommands(list, 'note edit', []).map((c) => c.id)).toEqual(['note.edit'])
    expect(matchCommands(list, 'nothing like it', [])).toEqual([])
  })
  it('puts the ones used last first when nothing starts with the typing, else keeps the order', () => {
    expect(matchCommands(list, '', ['go.calendar', 'editor.bold']).map((c) => c.id)).toEqual(['go.calendar', 'editor.bold', 'go.graph', 'note.edit'])
    expect(matchCommands(list, 'o', ['go.calendar']).map((c) => c.id)).toEqual(['go.calendar', 'go.graph', 'note.edit', 'editor.bold'])
  })
})

describe('the commands used last', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    })
  })
  afterEach(() => vi.unstubAllGlobals())
  it('come newest first, each once, at most six', () => {
    for (const id of ['a', 'b', 'c', 'a', 'd', 'e', 'f', 'g']) rememberCommand(id)
    expect(recentCommands()).toEqual(['g', 'f', 'e', 'd', 'a', 'c'])
  })
})
