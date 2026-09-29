/**
 * Quick capture: asked for from the palette, a long press on "+", Alt+Shift+N and the share target (`/capture`), and
 * shown by the app's frame (AppShell), like "New note". A page that asks before the frame listens (the share target
 * opens straight on `/capture`) leaves its words waiting (`takeCapture`).
 */
export const CAPTURE_EVENT = 'nexlore:capture'
const SPACE_KEY = 'nexlore.captureSpace'

let waiting: string | null = null

export function askCapture(text = ''): void {
  waiting = text
  window.dispatchEvent(new CustomEvent<string>(CAPTURE_EVENT, { detail: text }))
}

/** Words asked for before anyone listened; taken once. */
export function takeCapture(): string | null {
  const text = waiting
  waiting = null
  return text
}

/** The time of an entry as this browser's clock says: `2026-09-29 22:41`. */
export function stamp(now: Date): string {
  const two = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`
}

/** What a share brings (title, text, address) as the words of one entry, each once. */
export function sharedText(params: URLSearchParams): string {
  const parts: string[] = []
  for (const key of ['title', 'text', 'url']) {
    const value = params.get(key)?.trim()
    if (value && !parts.some((part) => part.includes(value))) parts.push(value)
  }
  return parts.join('\n')
}

export function lastSpace(): string {
  try {
    return localStorage.getItem(SPACE_KEY) ?? ''
  } catch {
    return ''
  }
}

export function rememberSpace(space: string): void {
  try {
    localStorage.setItem(SPACE_KEY, space)
  } catch {
    /* a private window: chosen again next time */
  }
}
