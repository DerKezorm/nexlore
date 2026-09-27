import { useEffect, useState } from 'react'

import { adminApi, type ServerSettings } from '../../api/client'

/** The server settings, loaded once for the cards that share them. */
export function useServerSettings() {
  const [settings, setSettings] = useState<ServerSettings | null>(null)
  useEffect(() => {
    void adminApi.settings().then(setSettings, () => setSettings(null))
  }, [])
  return [settings, setSettings] as const
}
