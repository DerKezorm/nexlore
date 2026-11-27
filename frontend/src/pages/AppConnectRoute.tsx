/**
 * The app connects by address (`/app-connect`): the system's secure browser window opens this page, the account signs
 * in as always first (second factor, passkey, provider; the sign-in leads back here), then confirms. The page is the
 * shared module's (geraete 0.1.0): with `state` (apps on the module) it hands a one-time code back to the app; with
 * `device` (the published nexlore app) it makes a pairing and hands its link over, as 1.16.0 did. Nothing happens
 * without the click.
 */
import { useTranslation } from 'react-i18next'

import { DEVICES_API, deviceRequest } from '../lib/devicesModule'
import { useAuth } from '../state/auth'
import { AppConnectPage } from '../vendor/nexgeraete'

export function AppConnectRoute() {
  const { i18n } = useTranslation()
  const { me } = useAuth()
  return (
    <AppConnectPage
      request={deviceRequest}
      base={DEVICES_API}
      app="nexlore"
      scheme="nexlore"
      account={me ? { name: me.display_name || me.name, login: me.name } : null}
      language={i18n.language}
    />
  )
}
