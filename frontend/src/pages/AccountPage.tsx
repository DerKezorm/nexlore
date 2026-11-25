/**
 * The areas of "My account" in the settings: Profile (picture, display name, username, email, language, role, and
 * signing out of this browser) and Security (password, second factor, recovery codes, passkeys, signed-in devices, the
 * mail at a new sign-in, the links to the providers) as the shared account module lays them out
 * (`settings/AccountCards.tsx`); Notifications, Plugins and Connections (paired iPhones, API tokens, AI in notes, keys
 * for AI from outside, the calendar feed) are nexlore's own. Which one shows is chosen by the settings page
 * (`SettingsPage.tsx`); the addresses of the tabs before lead there (`areas.ts`).
 */
import { AiAccess } from '../components/AiAccess'
import { AppDevices } from '../components/AppDevices'
import { ApiTokens } from '../components/ApiTokens'
import { McpKeys } from '../components/McpKeys'
import { NotifySettings } from '../components/NotifySettings'
import { CalendarFeed } from '../components/settings/CalendarFeed'
import { MyPluginsCard } from '../plugins/PluginSettings'
import { useAuth } from '../state/auth'
import { AccountNotices, ProfileCard, SecurityCard, SignOutCard } from './settings/AccountCards'
import type { AccountSlug } from './settings/areas'

/** The areas of the own account this page draws; the others ("Appearance", "Notes", "Spaces") are cards of their own. */
export type AccountPart = Extract<AccountSlug, 'profile' | 'security' | 'notifications' | 'plugins' | 'connections'>

export function AccountArea({ part }: { part: AccountPart }) {
  const { me } = useAuth()
  if (!me) return null
  return (
    <div className="space-y-6">
      {(part === 'profile' || part === 'security') && <AccountNotices me={me} />}
      {part === 'profile' && (
        <>
          <ProfileCard me={me} />
          <SignOutCard />
        </>
      )}
      {part === 'security' && <SecurityCard me={me} />}
      {part === 'connections' && (
        <>
          <AppDevices />
          <ApiTokens />
          <AiAccess />
          <McpKeys />
          <CalendarFeed />
        </>
      )}
      {part === 'notifications' && <NotifySettings />}
      {part === 'plugins' && <MyPluginsCard />}
    </div>
  )
}
