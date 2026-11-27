import { useCallback, useEffect, useState } from 'react'

import { adminApi, type ServerSettings } from '../../api/client'

/** The server settings, loaded once for the cards that share them. When they cannot be loaded, ``failed`` says so
 * (the cards that need them would otherwise just be missing) and ``reload`` asks again. */
export function useServerSettings() {
  const [settings, setSettings] = useState<ServerSettings | null>(null)
  const [failed, setFailed] = useState(false)
  const reload = useCallback(() => {
    setFailed(false)
    void adminApi.settings().then(setSettings, () => {
      setSettings(null)
      setFailed(true)
    })
  }, [])
  useEffect(reload, [reload])
  return [settings, setSettings, failed, reload] as const
}
