import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Space } from '../api/client'
import { addDays, dailySpace, isoDay, lastDay, monthGrid, rememberDailySpace, shiftMonth, taskParts, taskPlain, whenOf } from './everyday'

describe('dates for the calendar', () => {
  it('writes a local day as JJJJ-MM-TT and counts days over month and year ends', () => {
    expect(isoDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29')
  })

  it('moves by months and knows the last day of each', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(lastDay('2026-02')).toBe('2026-02-28')
    expect(lastDay('2028-02')).toBe('2028-02-29')
    expect(lastDay('2026-09')).toBe('2026-09-30')
  })

  it('lays a month out in weeks from Monday, with empty places around it', () => {
    const weeks = monthGrid('2026-09')
    // 1 September 2026 is a Tuesday, the 30th a Wednesday.
    expect(weeks[0]).toEqual([null, '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'])
    expect(weeks.at(-1)).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', null, null, null, null])
    expect(weeks.every((week) => week.length === 7)).toBe(true)
    // A month that starts on a Monday has no empty place in front.
    expect(monthGrid('2026-06')[0][0]).toBe('2026-06-01')
  })
})

describe('the groups of the overview', () => {
  const today = '2026-09-27'
  it.each([
    [{ due: '2026-09-26', scheduled: null }, 'overdue'],
    [{ due: '2026-09-27', scheduled: null }, 'today'],
    [{ due: null, scheduled: '2026-09-27' }, 'today'],
    [{ due: '2026-10-03', scheduled: null }, 'week'],
    [{ due: '2026-10-04', scheduled: null }, 'later'],
    [{ due: null, scheduled: null }, 'none'],
    // The due date counts before the scheduled one, as on the server.
    [{ due: '2026-10-20', scheduled: '2026-09-20' }, 'later'],
  ])('%o is %s', (task, group) => {
    expect(whenOf(task, today)).toBe(group)
  })
})

describe('the space of the daily note', () => {
  const spaces: Space[] = [
    { id: 1, name: 'Archive', notes: 0, files: 0, role: 'read' },
    { id: 2, name: 'Home', notes: 0, files: 0, role: 'write' },
    { id: 3, name: 'Work', notes: 0, files: 0, role: 'manage' },
  ]
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    })
  })

  it('is the one chosen last, and never one that may only be read', () => {
    expect(dailySpace(spaces)?.name).toBe('Home')
    rememberDailySpace('Work')
    expect(dailySpace(spaces)?.name).toBe('Work')
    rememberDailySpace('Archive')
    expect(dailySpace(spaces)?.name).toBe('Home')
    expect(dailySpace(spaces.slice(0, 1))).toBeNull()
  })
})

describe('the text of a task', () => {
  it('shows wiki links as the words they show', () => {
    expect(taskParts('Access only via [[WireGuard]] and [[Vaultwarden|the vault]], see [[Net#Ports]].')).toEqual([
      { text: 'Access only via ', link: false },
      { text: 'WireGuard', link: true },
      { text: ' and ', link: false },
      { text: 'the vault', link: true },
      { text: ', see ', link: false },
      { text: 'Net#Ports', link: true },
      { text: '.', link: false },
    ])
    expect(taskParts('no links')).toEqual([{ text: 'no links', link: false }])
    expect(taskPlain('Test a restore of [[Paperless]] and [[Vaultwarden|the vault]]')).toBe('Test a restore of Paperless and the vault')
  })
})
