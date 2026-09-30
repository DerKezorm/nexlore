import { describe, expect, it } from 'vitest'

import { taskLines } from './taskLines'

describe('the task lines of a note', () => {
  it('are the boxes the reading view shows, in their order, with their lines counted from 1', () => {
    const content = [
      '---',
      'todo: "- [ ] not a task"',
      '---',
      '- [ ] first',
      '```',
      '- [ ] in code',
      '```',
      '> - [x] quoted',
      '1. [ ] numbered',
      '- [-] cancelled is no box',
      '- [ ]',
      '- [ ]\tafter a tab',
      '- [X] last',
    ].join('\n')
    expect(taskLines(content)).toEqual([
      { line: 4, raw: '- [ ] first', done: false },
      { line: 8, raw: '> - [x] quoted', done: true },
      { line: 9, raw: '1. [ ] numbered', done: false },
      { line: 13, raw: '- [X] last', done: true },
    ])
  })
})
