/**
 * The areas of the settings, as in nexnotes, each with its own address (`/settings/<slug>`): "My account" for every
 * account, "Server" for the operator only, and "About nexlore" (`/settings/about`) for everyone at the end of the
 * navigation, outside the groups. `/settings` is the profile. The addresses of before (`/account?tab=…` with its
 * anchors, `/settings?tab=…&sub=…`, `/about`) lead to the area that holds their cards now: the server sends some of them
 * in notifications, and saved links keep working.
 */
import type { Account } from '../../api/client'
import type { SymbolName } from '../../components/Symbol'

type Role = Account['role']

export type AccountSlug = 'profile' | 'security' | 'appearance' | 'notes' | 'spaces' | 'notifications' | 'plugins' | 'connections'
export type ServerSlug = 'general' | 'sign-in' | 'mail' | 'storage' | 'shares' | 'extensions' | 'accounts' | 'log'
export type AreaSlug = AccountSlug | ServerSlug | 'about'
export type AreaGroup = 'account' | 'server'

export type Area = { slug: AreaSlug; group: AreaGroup; symbol: SymbolName; key: string }

/**
 * In the order of the navigation; `key` names the texts `settings.areas.<key>.title` and `.text`. Where an area is
 * also in nexnotes it has its name and place; the areas only nexlore has stand after them in their group.
 */
export const AREAS: Area[] = [
  { slug: 'profile', group: 'account', symbol: 'user', key: 'profile' },
  { slug: 'security', group: 'account', symbol: 'shieldCheck', key: 'security' },
  { slug: 'appearance', group: 'account', symbol: 'palette', key: 'appearance' },
  { slug: 'notes', group: 'account', symbol: 'note', key: 'notes' },
  { slug: 'spaces', group: 'account', symbol: 'space', key: 'spaces' },
  { slug: 'notifications', group: 'account', symbol: 'bell', key: 'notifications' },
  { slug: 'plugins', group: 'account', symbol: 'puzzle', key: 'plugins' },
  { slug: 'connections', group: 'account', symbol: 'plug', key: 'connections' },
  { slug: 'general', group: 'server', symbol: 'sliders', key: 'general' },
  { slug: 'sign-in', group: 'server', symbol: 'key', key: 'signIn' },
  { slug: 'mail', group: 'server', symbol: 'mail', key: 'mail' },
  { slug: 'storage', group: 'server', symbol: 'hardDrive', key: 'storage' },
  { slug: 'shares', group: 'server', symbol: 'globe', key: 'shares' },
  { slug: 'extensions', group: 'server', symbol: 'sparkle', key: 'extensions' },
  { slug: 'accounts', group: 'server', symbol: 'users', key: 'accounts' },
  { slug: 'log', group: 'server', symbol: 'scrollText', key: 'log' },
]

export const GROUPS: AreaGroup[] = ['account', 'server']

/** "About nexlore": an area of every account, below the groups (its `group` only says who may open it). */
export const ABOUT_AREA: Area = { slug: 'about', group: 'account', symbol: 'info', key: 'about' }

export function findArea(slug: AreaSlug): Area | undefined {
  return slug === ABOUT_AREA.slug ? ABOUT_AREA : AREAS.find((area) => area.slug === slug)
}

/** The areas an account may open: the operator all, a member those of its own account. */
export function areasFor(role: Role | undefined): Area[] {
  return role === 'operator' ? AREAS : AREAS.filter((area) => area.group === 'account')
}

export function areaPath(slug: AreaSlug): string {
  return `/settings/${slug}`
}

/** The tabs of "My account" before (`/account?tab=…`). */
const FORMER_ACCOUNT: Record<string, AreaSlug> = {
  profile: 'profile',
  security: 'security',
  notify: 'notifications',
  ai: 'connections',
  plugins: 'plugins',
}

/** The anchors of "My account" before (`/account#ai`): the card they named, in its area now. */
const FORMER_ANCHOR: Record<string, AreaSlug> = {
  '#ai': 'connections',
  '#mcp': 'connections',
  '#api-tokens': 'connections',
  '#calendar': 'connections',
  '#plugins': 'plugins',
  '#mail': 'profile',
}

/** The tabs of the settings before (`/settings?tab=…`, and `?tab=server&sub=…` for the server's parts). */
const FORMER_TAB: Record<string, AreaSlug> = { general: 'notes', looks: 'appearance', spaces: 'spaces', server: 'accounts' }
const FORMER_PART: Record<string, AreaSlug> = {
  accounts: 'accounts',
  signin: 'sign-in',
  mail: 'mail',
  shares: 'shares',
  extensions: 'extensions',
  files: 'general',
  backups: 'storage',
  languages: 'general',
  log: 'log',
}

/** Keeps the answer of a provider after linking (`?linked=`, `?error=`): it belongs to Security. */
function providerAnswer(params: URLSearchParams): string {
  const kept = new URLSearchParams()
  for (const name of ['linked', 'error']) {
    const value = params.get(name)
    if (value !== null) kept.set(name, value)
  }
  const text = kept.toString()
  return text ? `?${text}` : ''
}

/** Where `/account` of before leads now, its anchor kept, so the page still scrolls to the card. */
export function formerAccountAddress(search: string, hash: string): string {
  const params = new URLSearchParams(search)
  const answer = providerAnswer(params)
  if (answer) return areaPath('security') + answer
  const area = FORMER_ACCOUNT[params.get('tab') ?? ''] ?? FORMER_ANCHOR[hash] ?? 'profile'
  return areaPath(area) + hash
}

/**
 * Where an address of the settings leads: the area itself, or the address to go to instead (an address of before, an
 * area the account may not open, which goes to the profile).
 */
export function resolveArea(asked: string | undefined, role: Role | undefined, search: string, hash = ''): { area: AreaSlug } | { redirect: string } {
  const allowed = areasFor(role)
  const open = (slug: AreaSlug) => allowed.some((area) => area.slug === slug)
  if (asked === undefined) {
    const params = new URLSearchParams(search)
    const answer = providerAnswer(params)
    if (answer) return { redirect: areaPath('security') + answer }
    const tab = params.get('tab')
    if (tab === null) return { area: 'profile' }
    const sub = params.get('sub')
    // The server's "AI" stood in its part "AI, API and plugins" under an anchor of its own.
    const former = tab === 'server' && sub ? FORMER_PART[sub] : FORMER_TAB[tab]
    if (former && open(former)) return { redirect: areaPath(former) + hash }
    return { redirect: areaPath('profile') }
  }
  if (asked === ABOUT_AREA.slug || open(asked as AreaSlug)) return { area: asked as AreaSlug }
  return { redirect: areaPath('profile') }
}
