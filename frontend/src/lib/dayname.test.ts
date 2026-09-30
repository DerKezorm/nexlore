import { describe, expect, it } from 'vitest'

import { dayName, dayOfName } from './dayname'

describe('the names of daily notes', () => {
  it.each([
    [undefined, '2026-10-02'],
    ['YYYY-MM-DD', '2026-10-02'],
    ['DD.MM.YYYY', '02.10.2026'],
    ['D.M.YY', '2.10.26'],
    ['YYYY/MM/YYYY-MM-DD', '2026/10/2026-10-02'],
    ['[Day] YYYYMMDD', 'Day 20261002'],
  ])('%s names the 2nd of October 2026 %s, and reads it back', (pattern, name) => {
    expect(dayName(pattern, '2026-10-02')).toBe(name)
    expect(dayOfName(pattern, name)).toBe('2026-10-02')
  })

  it('reads no day where there is none, and none that does not exist', () => {
    expect(dayOfName('DD.MM.YYYY', '2026-10-02')).toBeNull()
    expect(dayOfName('DD.MM.YYYY', '31.02.2026')).toBeNull()
    expect(dayOfName(undefined, 'Shopping list')).toBeNull()
  })
})
