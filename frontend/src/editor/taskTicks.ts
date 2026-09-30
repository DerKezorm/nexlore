/**
 * Ticking a task off in the editor writes what the task list and the Tasks plugin write (review before 1.0.0, P5.2):
 * `✅ 2026-10-01` at its end (before a block id), and for a recurring task its next occurrence above it, every date
 * moved by as much as the reference date moved. Opening it again takes the done date (and a cancelled date) away.
 *
 * The rules are the server's (`backend/app/services/tasks.py`: `toggle_line`, `next_occurrence`, `next_date`); the
 * tests of both sides share their cases.
 */
import { Plugin, PluginKey, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import type { Node as PmNode } from '@milkdown/kit/prose/model'

const VS = '\\ufe0f?'
const DATE = '(\\d{4}-\\d{2}-\\d{2})'
const dated = (emoji: string) => new RegExp(`(?:${emoji})${VS}[ \\t]*${DATE}`, 'gu')
const DUE = () => dated('📅|📆|🗓')
const SCHEDULED = () => dated('⏳')
const START = () => dated('🛫')
const CREATED = () => dated('➕')
const DONE = /✅️?[ \t]*\d{4}-\d{2}-\d{2}/u
const DONE_APPENDED = /[ \t]*✅️?[ \t]*\d{4}-\d{2}-\d{2}/u
const CANCELLED_APPENDED = /[ \t]*❌️?[ \t]*\d{4}-\d{2}-\d{2}/u
const RECURRENCE = /🔁️?[ \t]*([^📅📆🗓⏳🛫✅➕❌⏫🔼🔽🔺⏬#^]*)/u
const BLOCK_ID = /[ \t]+\^[A-Za-z0-9-]+[ \t]*$/
const EVERY = /^every(?:\s+(\d{1,4}))?\s+(day|week|month|year)s?(?:\s+on\s+(.+?))?$/
const WEEKDAYS: Record<string, number> = {
  monday: 0, mon: 0, tuesday: 1, tue: 1, wednesday: 2, wed: 2, thursday: 3, thu: 3, friday: 4, fri: 4,
  saturday: 5, sat: 5, sunday: 6, sun: 6,
}

const DAY = 86_400_000
const toDay = (iso: string): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null
  const [y, m, d] = iso.split('-').map(Number)
  const time = Date.UTC(y, m - 1, d)
  const back = new Date(time)
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d ? time : null
}
const toIso = (time: number) => new Date(time).toISOString().slice(0, 10)
/** Monday 0 … Sunday 6, as Python's `weekday()`. */
const weekday = (time: number) => (new Date(time).getUTCDay() + 6) % 7

function addMonths(time: number, months: number): number {
  const day = new Date(time)
  const index = day.getUTCMonth() + months
  const year = day.getUTCFullYear() + Math.floor(index / 12)
  const month = ((index % 12) + 12) % 12
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return Date.UTC(year, month, Math.min(day.getUTCDate(), last))
}

/** The next date after `reference` by a rule as the Tasks plugin writes it; null for a rule it does not know. */
export function nextDate(rule: string, reference: string): string | null {
  const start = toDay(reference)
  if (start === null) return null
  const clean = rule.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*when done$/, '')
  if (clean === 'every weekday') {
    let step = start + DAY
    while (weekday(step) >= 5) step += DAY
    return toIso(step)
  }
  const match = EVERY.exec(clean)
  if (!match) return null
  const count = Number(match[1] ?? 1)
  const unit = match[2]
  if (count < 1) return null
  if (unit === 'week' && match[3]) {
    const days = new Set<number>()
    for (const part of match[3].split(/\s*(?:,|and)\s*/)) {
      if (!(part in WEEKDAYS)) return null
      days.add(WEEKDAYS[part])
    }
    const monday = start - weekday(start) * DAY
    let step = start + DAY
    for (let i = 0; i < 7 * count + 7; i++) {
      const weeksApart = Math.round((step - weekday(step) * DAY - monday) / (7 * DAY))
      if (days.has(weekday(step)) && weeksApart % count === 0) return toIso(step)
      step += DAY
    }
    return null
  }
  if (match[3]) return null
  if (unit === 'day') return toIso(start + count * DAY)
  if (unit === 'week') return toIso(start + count * 7 * DAY)
  return toIso(addMonths(start, unit === 'month' ? count : 12 * count))
}

type Edit = { from: number; to: number; text: string }

/** What ticking off (or opening again) changes in a task's text after its box: edits, last first. */
export function tickEdits(text: string, done: boolean, today: string): Edit[] {
  if (done) {
    if (DONE.test(text)) return []
    const block = BLOCK_ID.exec(text)
    const end = block ? block.index : text.length
    const body = text.slice(0, end).replace(/[ \t]+$/, '')
    return [{ from: body.length, to: end === text.length ? text.length : end, text: body ? ` ✅ ${today}` : `✅ ${today}` }]
  }
  const edits: Edit[] = []
  for (const pattern of [DONE_APPENDED, CANCELLED_APPENDED]) {
    const found = pattern.exec(text)
    if (found) edits.push({ from: found.index, to: found.index + found[0].length, text: '' })
  }
  return edits.sort((a, b) => b.from - a.from)
}

/**
 * The edits that make a ticked-off recurring task's text its next occurrence (open, dates moved, made today, no done
 * date, no block id), last first; null when it does not recur, has no date or its rule is unknown.
 */
export function nextEdits(text: string, today: string): Edit[] | null {
  const rule = RECURRENCE.exec(text)?.[1]?.trim()
  if (!rule) return null
  const first = (pattern: RegExp) => pattern.exec(text)?.[1] ?? null
  const due = first(DUE())
  const scheduled = first(SCHEDULED())
  const begin = first(START())
  const referenceText = due ?? scheduled ?? begin
  if (!referenceText) return null
  const reference = toDay(referenceText)
  if (reference === null || [due, scheduled, begin].some((other) => other !== null && toDay(other) === null)) return null
  const base = rule.toLowerCase().endsWith('when done') ? today : referenceText
  const following = nextDate(rule, base)
  if (!following) return null
  const shift = toDay(following)! - reference
  const edits: Edit[] = []
  const done = DONE_APPENDED.exec(text)
  if (done) edits.push({ from: done.index, to: done.index + done[0].length, text: '' })
  const cancelled = new RegExp(`❌${VS}[ \\t]*${DATE}`, 'gu')
  for (const found of text.matchAll(cancelled)) edits.push({ from: found.index!, to: found.index! + found[0].length, text: '' })
  for (const pattern of [DUE(), SCHEDULED(), START()]) {
    for (const found of text.matchAll(pattern)) {
      const at = found.index! + found[0].length - 10
      edits.push({ from: at, to: at + 10, text: toIso(toDay(found[1])! + shift) })
    }
  }
  for (const found of text.matchAll(CREATED())) {
    const at = found.index! + found[0].length - 10
    edits.push({ from: at, to: at + 10, text: today })
  }
  const block = BLOCK_ID.exec(text)
  if (block) edits.push({ from: block.index, to: text.length, text: '' })
  return edits.sort((a, b) => b.from - a.from)
}

/** The day on this device's clock, `2026-10-01`. */
function localToday(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** The text of a paragraph with one character for each leaf (a picture, a break): offsets match positions. */
const flat = (paragraph: PmNode) => paragraph.textBetween(0, paragraph.content.size, '', '￼')

function apply(tr: Transaction, start: number, edits: Edit[], schema: EditorState['schema']): void {
  for (const edit of edits) {
    if (edit.text) tr.replaceWith(start + edit.from, start + edit.to, schema.text(edit.text))
    else tr.delete(start + edit.from, start + edit.to)
  }
}

export const taskTicksKey = new PluginKey('nxTaskTicks')

export function taskTicks(today: () => string = localToday) {
  return new Plugin({
    key: taskTicksKey,
    appendTransaction(transactions, _before, state) {
      const ticks: { pos: number; done: boolean }[] = []
      for (const tr of transactions) {
        // Undo and redo bring back what was there, the text included; a change from elsewhere is no click.
        if (tr.getMeta('history$') || tr.getMeta('addToHistory') === false || tr.getMeta(taskTicksKey)) continue
        tr.steps.forEach((step, index) => {
          // By its JSON, not `instanceof`: the bundler may hold the step class twice.
          const json = step.toJSON() as { stepType?: string; pos?: number; attr?: string; value?: unknown }
          if (json.stepType !== 'attr' || json.attr !== 'checked' || typeof json.value !== 'boolean' || typeof json.pos !== 'number') return
          const before = tr.docs[index].nodeAt(json.pos)
          if (before?.attrs.checked !== !json.value) return
          ticks.push({ pos: tr.mapping.slice(index + 1).map(json.pos), done: json.value })
        })
      }
      if (!ticks.length) return null
      const tr = state.tr.setMeta(taskTicksKey, true)
      const day = today()
      // Last first: what changes further down moves nothing above it.
      for (const { pos, done } of ticks.sort((a, b) => b.pos - a.pos)) {
        const item = state.doc.nodeAt(pos)
        const paragraph = item?.firstChild
        if (!item || item.type.name !== 'list_item' || !paragraph || !paragraph.isTextblock) continue
        const text = flat(paragraph)
        apply(tr, pos + 2, tickEdits(text, done, day), state.schema)
        const next = done ? nextEdits(text, day) : null
        if (next) {
          // The next occurrence above the one ticked off, only its own line (not what is nested under it).
          const copy = item.type.create({ ...item.attrs, checked: false }, [paragraph])
          tr.insert(pos, copy)
          apply(tr, pos + 2, next, state.schema)
        }
      }
      return tr.docChanged ? tr : null
    },
  })
}
