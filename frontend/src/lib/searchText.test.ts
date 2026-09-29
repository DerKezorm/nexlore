import { operator, pieces, replaced, toggled, without } from './searchText'

describe('the search text as pieces', () => {
  it('keeps quoted values, phrases and properties together', () => {
    expect(pieces('space:"Mein Wissen" "zfs pool" [status:open] -test word')).toEqual(['space:"Mein Wissen"', '"zfs pool"', '[status:open]', '-test', 'word'])
  })
  it('takes a piece out, toggles one, replaces one of a kind', () => {
    expect(without('a tag:x b', 'tag:x')).toBe('a b')
    expect(toggled('a', 'task:')).toBe('a task:')
    expect(toggled('a task:', 'task:')).toBe('a')
    expect(replaced('a changed:7d b', 'changed:', 'changed:30d')).toBe('a b changed:30d')
    expect(replaced('a changed:7d', 'changed:', null)).toBe('a')
    expect(operator('space', 'Mein Wissen')).toBe('space:"Mein Wissen"')
    expect(operator('tag', 'garden')).toBe('tag:garden')
  })
})
