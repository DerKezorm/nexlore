import { describe, expect, it } from 'vitest'

import { pastedExample } from './pastedName'

describe('the example under the pattern for pasted pictures', () => {
  const moment = new Date(2026, 10, 8, 14, 5, 9)

  it('fills in what the server fills in', () => {
    expect(pastedExample('{note} {n}', 'Shopping', moment)).toBe('Shopping 1')
    expect(pastedExample('{date} {note} {n:3}', 'Shopping', moment)).toBe('2026-11-08 Shopping 001')
    expect(pastedExample('{note}-{date}_{time}', 'Shopping', moment)).toBe('Shopping-2026-11-08_14-05-09')
  })

  it('leaves what is no placeholder as it stands', () => {
    expect(pastedExample('  {title} {n} ', 'Shopping', moment)).toBe('{title} 1')
  })
})
