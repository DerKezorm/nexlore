/** The rules of ticking off, as the server has them (cases from `backend/tests/test_tasks_templates.py`). */
import { describe, expect, it } from 'vitest'

import { nextDate, nextEdits, tickEdits } from './taskTicks'

const applied = (text: string, edits: { from: number; to: number; text: string }[] | null) =>
  edits === null ? null : edits.reduce((out, edit) => out.slice(0, edit.from) + edit.text + out.slice(edit.to), text)

describe('the next date of a rule', () => {
  it.each([
    ['every day', '2026-09-27', '2026-09-28'],
    ['every 3 days', '2026-09-27', '2026-09-30'],
    ['every week', '2026-09-27', '2026-10-04'],
    ['every 2 weeks', '2026-09-27', '2026-10-11'],
    ['every month', '2026-01-31', '2026-02-28'],
    ['every 2 months', '2026-11-30', '2027-01-30'],
    ['every year', '2028-02-29', '2029-02-28'],
    ['every weekday', '2026-09-25', '2026-09-28'],
    ['every weekday', '2026-09-28', '2026-09-29'],
    ['Every week on Monday, Friday', '2026-09-28', '2026-10-02'],
    ['every week on friday and monday', '2026-10-02', '2026-10-05'],
    ['every 2 weeks on monday', '2026-09-28', '2026-10-12'],
    ['every month when done', '2026-09-27', '2026-10-27'],
  ])('%s after %s is %s', (rule, reference, following) => {
    expect(nextDate(rule, reference)).toBe(following)
  })

  it.each(['every blue moon', 'every 0 days', 'every month on the 3rd', 'every week on funday'])('%s repeats nothing', (rule) => {
    expect(nextDate(rule, '2026-09-27')).toBeNull()
  })
})

describe('ticking off', () => {
  it('writes the done date at the end, before a block id, and takes it away again', () => {
    expect(applied('water 📅 2026-09-27', tickEdits('water 📅 2026-09-27', true, '2026-10-01'))).toBe('water 📅 2026-09-27 ✅ 2026-10-01')
    expect(applied('water ^w1', tickEdits('water ^w1', true, '2026-10-01'))).toBe('water ✅ 2026-10-01 ^w1')
    expect(tickEdits('water ✅ 2026-09-30', true, '2026-10-01')).toEqual([])
    expect(applied('water ✅ 2026-10-01 ^w1', tickEdits('water ✅ 2026-10-01 ^w1', false, '2026-10-01'))).toBe('water ^w1')
    expect(applied('water ❌ 2026-09-30', tickEdits('water ❌ 2026-09-30', false, '2026-10-01'))).toBe('water')
  })

  it('makes the next occurrence with every date moved by as much as the reference moved', () => {
    const text = 'water 🔁 every week 🛫 2026-09-20 ⏳ 2026-09-25 📅 2026-09-27 ➕ 2026-09-01 ^w1'
    expect(applied(text, nextEdits(text, '2026-09-27'))).toBe('water 🔁 every week 🛫 2026-09-27 ⏳ 2026-10-02 📅 2026-10-04 ➕ 2026-09-27')
    const late = 'water 🔁 every week when done 📅 2026-09-01'
    expect(applied(late, nextEdits(late, '2026-09-27'))).toBe('water 🔁 every week when done 📅 2026-10-04')
    expect(applied('a 🔁 every day ⏳ 2026-09-27', nextEdits('a 🔁 every day ⏳ 2026-09-27', '2026-09-27'))).toBe('a 🔁 every day ⏳ 2026-09-28')
  })

  it.each(['no rule 📅 2026-09-27', 'no date 🔁 every day', 'odd 🔁 every blue moon 📅 2026-09-27', 'x 🔁 every month 📅 2026-02-30'])(
    '%s has no next occurrence',
    (text) => {
      expect(nextEdits(text, '2026-09-27')).toBeNull()
    },
  )
})
