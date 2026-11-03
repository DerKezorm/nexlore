/** Small rules of pairing the iPhone app in the browser (`components/AppDevices.tsx`, `pages/AppConnectPage.tsx`). */

/** What a device may call itself on the sign-in page: printable, at most 80 characters, as the server keeps it. */
export function deviceName(raw: string | null): string {
  const clean = Array.from(raw ?? '')
    .filter((char) => char >= ' ' && char !== '\u007f')
    .join('')
    .trim()
    .slice(0, 80)
  return clean || 'iPhone'
}

/** Whole minutes a pairing still lives, never below zero. */
export function minutesLeft(until: string, now: number): number {
  return Math.max(0, Math.ceil((new Date(until).getTime() - now) / 60000))
}
