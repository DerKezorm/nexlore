/** This tab has a note open: said every little while, goodbye when it goes; who else has it open comes back. */
import { useEffect, useState } from 'react'

import { presenceApi, type Present } from '../api/client'

/** How often a page says it is still here; the server forgets it after 70 seconds of silence. */
const BEAT_MS = 25_000
export function usePresence(path: string | null, editing: boolean): Present[] {
  const [people, setPeople] = useState<Present[]>([])
  useEffect(() => {
    if (!path) return
    let alive = true
    const beat = () =>
      presenceApi.here(path).then(
        (answer) => alive && setPeople(answer.people),
        () => alive && setPeople([]),
      )
    void beat()
    const timer = window.setInterval(beat, BEAT_MS)
    // Closing or reloading the tab runs no clean-up of React: the goodbye goes out on the way. Already before the
    // page unloads: under the service worker a request sent from `pagehide` was lost every time (measured 4 of 4);
    // `pagehide` stays for phones, which often skip `beforeunload`.
    const goodbye = () => void presenceApi.gone(path).catch(() => {})
    window.addEventListener('pagehide', goodbye)
    window.addEventListener('beforeunload', goodbye)
    return () => {
      alive = false
      window.clearInterval(timer)
      window.removeEventListener('pagehide', goodbye)
      window.removeEventListener('beforeunload', goodbye)
      setPeople([])
      goodbye()
    }
    // A change between reading and writing is said at once (the others see the pencil come and go).
  }, [path, editing])
  return people
}
