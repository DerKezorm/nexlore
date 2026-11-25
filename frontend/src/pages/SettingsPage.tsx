/**
 * Settings (plan "Einstellungen") in the frame of the ui kit: `SettingsLayout` with `SettingsNav` (the account at the
 * top, "Mein Konto", "Server" for the operator, "Über nexlore" set apart at the end) and one `SettingsPage` per area:
 * its title, one line, then only cards. As before the app's sidebar with the spaces stays on the left. Each area has
 * its own address (`/settings/<slug>`, `settings/areas.ts`); `/settings` alone is the list on a phone and the profile
 * beside the navigation on a wider page. An area someone may not open, or an address of before (`/account?tab=…`,
 * `/settings?tab=…&sub=…`, `/settings/extensions`, `/about`), leads on with the address replaced, so the navigation
 * always marks where one is. The cards of an area are chosen in `settings/SettingsAreas.tsx`.
 */
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useLocation, useParams } from 'react-router-dom'

import { Avatar } from '../components/Avatar'
import { SpacesSidebar } from '../components/Sidebar'
import { useAuth } from '../state/auth'
import { areaText, languageOf, NEXUI_TEXTS, NexuiLanguage, SettingsLayout, SettingsNav, SettingsPage as Area, type SettingsGroup } from '../vendor/nexui'
import { ABOUT_AREA, areaPath, areasFor, findArea, formerAccountAddress, GROUPS, resolveArea, type Area as AreaInfo } from './settings/areas'
import { AreaContent } from './settings/SettingsAreas'

const APP = 'nexlore'

export function SettingsPage() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const { area: asked } = useParams()
  const { search, hash } = useLocation()
  if (!me) return null
  const where = resolveArea(asked, me.role, search, hash)
  if ('redirect' in where) return <Navigate to={where.redirect} replace />
  const area = findArea(where.area)
  if (!area) return null
  const things = t('settings.things')
  const kit = NEXUI_TEXTS[languageOf(i18n.language)]
  const words = (info: AreaInfo) => {
    const shared = areaText(kit, info.slug, { app: APP, things })
    if (!info.own) return shared ?? { title: info.slug, text: '' }
    return { title: shared?.title || t(`settings.areas.${info.key}.title`), text: t(`settings.areas.${info.key}.text`) }
  }
  const groups: SettingsGroup[] = GROUPS.map((group) => ({
    id: group,
    areas: areasFor(me.role)
      .filter((entry) => entry.group === group)
      .map((entry) => ({ slug: entry.slug, icon: entry.icon, href: areaPath(entry.slug), title: entry.own ? words(entry).title : undefined })),
  }))
  const shown = me.display_name || me.name
  const own = area.own ? words(area) : null
  return (
    <>
      <SpacesSidebar />
      <main className="nn-scroll flex-1 overflow-y-auto">
        <NexuiLanguage language={i18n.language}>
          <SettingsLayout
            list={asked === undefined}
            back="/settings"
            link={Link}
            nav={
              <SettingsNav
                app={APP}
                things={things}
                groups={groups}
                about={{ href: areaPath(ABOUT_AREA.slug), slug: ABOUT_AREA.slug }}
                current={area.slug}
                account={{ name: shown, role: t(`me.role.${me.role}`), picture: <Avatar account={me} className="h-10 w-10 shrink-0 text-base" /> }}
                link={Link}
              />
            }
          >
            <Area slug={area.slug} app={APP} things={things} title={own?.title} subtitle={own?.text}>
              <AreaContent key={area.slug} area={area.slug} />
            </Area>
          </SettingsLayout>
        </NexuiLanguage>
      </main>
    </>
  )
}

/** `/account` of before: the server still sends people there (notifications, the way back from a provider). */
export function FormerAccountAddress() {
  const { search, hash } = useLocation()
  return <Navigate to={formerAccountAddress(search, hash)} replace />
}

/** `/about` of before: "About nexlore" is an area of the settings now. */
export function FormerAboutAddress() {
  return <Navigate to={areaPath('about')} replace />
}
