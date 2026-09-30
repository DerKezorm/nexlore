/** Dates in words, German and English, from a fixed today (Wednesday, 30 September 2026). */
import { describe, expect, it } from 'vitest'

import { dateWords, isoDate, parseDateWords } from './dates'

const TODAY = new Date(2026, 8, 30, 9, 15)
const day = (phrase: string) => {
  const found = parseDateWords(phrase, TODAY)
  return found && isoDate(found)
}

describe('dates in words', () => {
  it('knows the days around today in both languages', () => {
    expect(day('heute')).toBe('2026-09-30')
    expect(day('Morgen')).toBe('2026-10-01')
    expect(day('übermorgen')).toBe('2026-10-02')
    expect(day('gestern')).toBe('2026-09-29')
    expect(day('vorgestern')).toBe('2026-09-28')
    expect(day('today')).toBe('2026-09-30')
    expect(day('tomorrow')).toBe('2026-10-01')
    expect(day('day after tomorrow')).toBe('2026-10-02')
    expect(day('yesterday')).toBe('2026-09-29')
  })

  it('takes a weekday as the next one after today, today itself a week on', () => {
    expect(day('freitag')).toBe('2026-10-02')
    expect(day('nächsten Freitag')).toBe('2026-10-02')
    expect(day('next friday')).toBe('2026-10-02')
    expect(day('montag')).toBe('2026-10-05')
    expect(day('mittwoch')).toBe('2026-10-07')
    expect(day('nächste Woche')).toBe('2026-10-05')
    expect(day('next month')).toBe('2026-10-01')
  })

  it('counts days, weeks, months and years ahead and back', () => {
    expect(day('in 3 Tagen')).toBe('2026-10-03')
    expect(day('in 1 Tag')).toBe('2026-10-01')
    expect(day('in 2 weeks')).toBe('2026-10-14')
    expect(day('in 5 Monaten')).toBe('2027-02-28')
    expect(day('in 1 year')).toBe('2027-09-30')
    expect(day('vor 2 Wochen')).toBe('2026-09-16')
    expect(day('3 days ago')).toBe('2026-09-27')
  })

  it('reads written dates and refuses days that are none', () => {
    expect(day('1.10.')).toBe('2026-10-01')
    expect(day('24.12.2027')).toBe('2027-12-24')
    expect(day('24.12.27')).toBe('2027-12-24')
    expect(day('2026-11-05')).toBe('2026-11-05')
    expect(day('31.2.')).toBeNull()
    expect(day('in drei Tagen')).toBeNull()
    expect(day('anna')).toBeNull()
    expect(day('')).toBeNull()
  })

  it('offers words while they are typed, the words themselves first when they mean a day', () => {
    expect(dateWords('mo', TODAY).map((word) => word.phrase)).toEqual(['morgen', 'montag', 'monday'])
    expect(dateWords('morgen', TODAY).map((word) => [word.phrase, isoDate(word.date)])).toEqual([['morgen', '2026-10-01']])
    expect(dateWords('in 3 tagen', TODAY)).toHaveLength(1)
    expect(dateWords('xyz', TODAY)).toEqual([])
  })
})
