/**
 * `/capture`: where sharing to the installed app lands (the manifest's share target), and its shortcut. The words
 * shared go to quick capture, shown by the app's frame; the address becomes the start page again.
 */
import { useEffect } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'

import { askCapture, sharedText } from '../lib/capture'

export function CaptureRoute() {
  const [params] = useSearchParams()
  useEffect(() => {
    askCapture(sharedText(params))
    // Once per arrival: the page goes on to "/" right away.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <Navigate to="/" replace />
}
