/** Days, times and sizes as the account pages write them (the operator's list of accounts, the devices, passkeys). */

/** A day: "20.11.2026" in German, "Nov 20, 2026" otherwise. */
export function day(value: string | number | Date, lang: string): string {
  const date = new Date(value)
  if (lang.startsWith('de')) return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
  return date.toLocaleDateString(lang, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** A day with the time: "20.11.2026, 08:14" or "Nov 20, 2026, 8:14 AM". */
export function dayTime(value: string | number | Date, lang: string): string {
  const date = new Date(value)
  const time = date.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })
  return `${day(date, lang)}, ${time}`
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
