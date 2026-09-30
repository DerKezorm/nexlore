import { describe, expect, it } from 'vitest'

import { zettelName } from './zettel'

describe('a note named by the time', () => {
  it('takes year, month, day, hour and minute in local time, each with its zeros', () => {
    expect(zettelName(new Date(2026, 8, 30, 12, 45, 59))).toBe('202609301245')
    expect(zettelName(new Date(2027, 0, 2, 3, 4))).toBe('202701020304')
    expect(zettelName(new Date(2026, 11, 31, 23, 59))).toBe('202612312359')
  })
})
