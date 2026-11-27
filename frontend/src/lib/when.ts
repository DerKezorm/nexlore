/** Days, times and sizes as the account pages write them (the operator's list of accounts, the devices, passkeys). */
import { formatDay, formatMoment } from '../vendor/nexui'


/** A day in the one form of every nex app (E65, ui 1.1.2): "20.11.2026" in German, "20/11/2026" in English. */
export function day(value: string | number | Date, lang: string): string {
  return formatDay(new Date(value), lang)
}

/** A moment (E65): "heute, 08:14", "gestern, 08:14", else "20.11.2026, 08:14". */
export function dayTime(value: string | number | Date, lang: string): string {
  return formatMoment(new Date(value), lang)
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** A size as the language writes it: "1,5 MB" or "1.5 MB". */
export function bytes(value: number, lang: string): string {
  let size = Math.max(0, value)
  let unit = 0
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024
    unit++
  }
  const digits = unit >= 2 && size < 100 ? 1 : 0
  const shown = new Intl.NumberFormat(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(size)
  return `${shown} ${UNITS[unit]}`
}
