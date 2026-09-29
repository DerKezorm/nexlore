/** Quick capture's helpers: the time an entry gets, and what a share brings. */
import { describe, expect, it } from 'vitest'

import { askCapture, sharedText, stamp, takeCapture } from './capture'

describe('quick capture', () => {
  it('stamps with the local time, two digits each', () => {
    expect(stamp(new Date(2026, 0, 5, 7, 3))).toBe('2026-01-05 07:03')
    expect(stamp(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31 23:59')
  })

  it('takes title, text and address of a share, each once, one per line', () => {
    expect(sharedText(new URLSearchParams('title=Heron&text=Seen+today&url=https%3A%2F%2Fexample.com%2Fh'))).toBe(
      'Heron\nSeen today\nhttps://example.com/h',
    )
    // Many apps put the address into the text as well.
    expect(sharedText(new URLSearchParams('text=Look+https%3A%2F%2Fexample.com%2Fh&url=https%3A%2F%2Fexample.com%2Fh'))).toBe(
      'Look https://example.com/h',
    )
    expect(sharedText(new URLSearchParams(''))).toBe('')
  })

  it('keeps words asked for before anyone listened, for one taker', () => {
    askCapture('early')
    expect(takeCapture()).toBe('early')
    expect(takeCapture()).toBeNull()
  })
})
