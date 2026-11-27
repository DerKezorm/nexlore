import { useEffect, useState } from 'react'

import { narrow } from './shell'

/** Whether the window is a phone's (no sidebar column, below `SHEET_BELOW`), followed as it changes. */
export function useNarrow(): boolean {
  const [small, setSmall] = useState(narrow)
  useEffect(() => {
    const follow = () => setSmall(narrow())
    follow()
    window.addEventListener('resize', follow)
    return () => window.removeEventListener('resize', follow)
  }, [])
  return small
}
