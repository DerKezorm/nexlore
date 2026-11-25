/**
 * The way through the settings, as in nexnotes. Where the page is wide enough (700 px of its own), a navigation on the
 * left of the content: the account at the top, then the groups "My account" and, for the operator, "Server", and
 * "About nexlore" at the end. Narrower, a choice above the content goes to the area chosen. The page's own width
 * counts, not the window's: beside the sidebar a laptop is narrow too.
 */
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'

import type { Account } from '../../api/client'
import { Avatar } from '../../components/Avatar'
import { Symbol } from '../../components/Symbol'
import { ABOUT_AREA, areaPath, areasFor, GROUPS, type AreaSlug } from './areas'

const ENTRY = 'flex items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-sm transition-colors '
const CHOSEN = 'bg-accent-500/15 font-medium text-accent-400'
const QUIET = 'text-mist-300 hover:bg-ink-850 hover:text-mist-100'

export function SettingsNav({ me, current }: { me: Account; current: AreaSlug }) {
  const { t } = useTranslation()
  const areas = areasFor(me.role)
  const groups = GROUPS.filter((group) => areas.some((area) => area.group === group))
  const shown = me.display_name || me.name
  return (
    <nav aria-label={t('nav.settings')} className="hidden w-56 shrink-0 @min-[700px]:sticky @min-[700px]:top-0 @min-[700px]:block" data-testid="settings-nav">
      <div className="mb-4 flex items-center gap-3 px-2.5">
        <Avatar account={me} className="h-10 w-10 shrink-0 text-base" />
        <div className="min-w-0">
          <p className="truncate font-semibold text-mist-100" title={shown}>
            {shown}
          </p>
          <p className="text-xs text-mist-500">{t(`me.role.${me.role}`)}</p>
        </div>
      </div>
      {groups.map((group) => (
        <div key={group} className="mb-4">
          <p id={`settings-group-${group}`} className="px-2.5 pb-1.5 text-[11px] font-semibold tracking-wider text-mist-500 uppercase">
            {t(`settings.groups.${group}`)}
          </p>
          <ul aria-labelledby={`settings-group-${group}`} className="space-y-0.5">
            {areas
              .filter((area) => area.group === group)
              .map(({ slug, key, symbol }) => {
                const here = slug === current
                return (
                  <li key={slug}>
                    <Link to={areaPath(slug)} aria-current={here ? 'page' : undefined} className={ENTRY + (here ? CHOSEN : QUIET)} data-testid={`settings-nav-${slug}`}>
                      <Symbol name={symbol} className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 truncate">{t(`settings.areas.${key}.title`)}</span>
                    </Link>
                  </li>
                )
              })}
          </ul>
        </div>
      ))}
      <div className="border-t border-ink-700 pt-2">
        <Link
          to={areaPath(ABOUT_AREA.slug)}
          aria-current={current === ABOUT_AREA.slug ? 'page' : undefined}
          className={ENTRY + (current === ABOUT_AREA.slug ? CHOSEN : QUIET)}
          data-testid="settings-nav-about"
        >
          <Symbol name="info" className="h-4 w-4 shrink-0" />
          <span className="min-w-0 truncate">{t(`settings.areas.${ABOUT_AREA.key}.title`)}</span>
        </Link>
      </div>
    </nav>
  )
}

/** The narrow page: one choice with the groups and "About nexlore". */
export function SettingsJump({ me, current }: { me: Account; current: AreaSlug }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const areas = areasFor(me.role)
  const groups = GROUPS.filter((group) => areas.some((area) => area.group === group))
  return (
    <label className="block @min-[700px]:hidden" data-testid="settings-jump-row">
      <span className="sr-only">{t('settings.jump')}</span>
      <select
        className="h-10 w-full rounded-[9px] border border-ink-700 bg-ink-850 px-3 text-sm text-mist-100"
        value={current}
        onChange={(event) => navigate(areaPath(event.target.value as AreaSlug))}
        data-testid="settings-jump"
      >
        {groups.map((group) => (
          <optgroup key={group} label={t(`settings.groups.${group}`)}>
            {areas
              .filter((area) => area.group === group)
              .map(({ slug, key }) => (
                <option key={slug} value={slug}>
                  {t(`settings.areas.${key}.title`)}
                </option>
              ))}
          </optgroup>
        ))}
        <option value={ABOUT_AREA.slug}>{t(`settings.areas.${ABOUT_AREA.key}.title`)}</option>
      </select>
    </label>
  )
}
