import { afterEach, describe, expect, it } from 'vitest'
import { keepFolds, storedFolds } from './spaceFold'

describe('spaces folded by hand (GitHub issue 22)', () => {
  afterEach(() => localStorage.clear())

  it('keeps the closed spaces and gives them back as closed rows', () => {
    keepFolds(new Map([['Work', false], ['Home', true], ['Archive', false]]))
    expect([...storedFolds()]).toEqual([['Archive', false], ['Work', false]])
  })

  it('keeps no folder inside a space: those open on the way to the note shown', () => {
    keepFolds(new Map([['Work/Projects', false], ['Work', true]]))
    expect(storedFolds().size).toBe(0)
    expect(localStorage.getItem('nexlore.closedSpaces')).toBeNull()
  })

  it('forgets a space opened again', () => {
    keepFolds(new Map([['Work', false]]))
    keepFolds(new Map([['Work', true]]))
    expect(storedFolds().size).toBe(0)
  })

  it('takes nothing odd from the storage', () => {
    localStorage.setItem('nexlore.closedSpaces', '{"Work": false}')
    expect(storedFolds().size).toBe(0)
    localStorage.setItem('nexlore.closedSpaces', '["Work", 3, "", "Work/Sub", null]')
    expect([...storedFolds()]).toEqual([['Work', false]])
    localStorage.setItem('nexlore.closedSpaces', 'not json')
    expect(storedFolds().size).toBe(0)
  })
})
