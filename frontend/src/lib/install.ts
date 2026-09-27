/**
 * Installing nexlore as an app (M6): the browser's own install dialog, kept for when the person asks
 * (`beforeinstallprompt` comes once, early), or on iPhone and iPad the hint for Safari, which has no dialog.
 */
import { useEffect, useState } from 'react'

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }

let waiting: InstallEvent | null = null
const listeners = new Set<() => void>()

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    waiting = event as InstallEvent
    for (const listener of listeners) listener()
  })
  window.addEventListener('appinstalled', () => {
    waiting = null
    for (const listener of listeners) listener()
  })
}

function standalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
}

function appleMobile(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

/** Whether the app can be installed here now, and how: the browser's own dialog, or the hint for Safari. */
export function useInstall(): { can: 'prompt' | 'ios' | null; install: () => Promise<void> } {
  const [, setTick] = useState(0)
  useEffect(() => {
    const listener = () => setTick((value) => value + 1)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  const can = standalone() ? null : waiting ? 'prompt' : appleMobile() ? 'ios' : null
  const install = async () => {
    if (!waiting) return
    const event = waiting
    waiting = null
    await event.prompt()
    await event.userChoice.catch(() => undefined)
    for (const listener of listeners) listener()
  }
  return { can, install }
}
