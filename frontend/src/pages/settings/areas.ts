/**
 * The areas of the settings, each with its own address (`/settings/<slug>`, plan "Einstellungen"): "Mein Konto" for
 * every account (Profile, Security, Appearance, nexlore's own Notes, Spaces and Plugins, Notifications, Connections),
 * "Server" for the operator only (General, Sign-in, Mail, Storage and backups, nexlore's own AI provider, Plugins and
 * Public pages, Accounts, Log), and "Über nexlore" (`/settings/about`) for everyone, set apart at the end. Titles and
 * lines of the shared areas come from the ui kit (`areaText`), nexlore's own keep theirs.
 *
 * `/settings` alone is the list on a phone and the profile beside it on a wider page. The addresses of before lead to
 * the area that holds their cards now: `/account?tab=…` with its anchors, `/settings?tab=…&sub=…`, `/about`, and the
 * area "AI, API and plugins" (`/settings/extensions`), which went to AI provider, General › Interfaces and Plugins.
 * The server sends some of them in notifications, and saved links keep working.
 */
import { BookOpen, FolderTree, Globe, Puzzle, Sparkles } from 'lucide-react'

import type { Account } from '../../api/client'
import type { GeneralPart, IconLike } from '../../vendor/nexui'

type Role = Account['role']

export type AccountSlug = 'profile' | 'security' | 'appearance' | 'notes' | 'spaces' | 'plugins' | 'ai' | 'notifications' | 'connections'
export type ServerSlug = 'general' | 'sign-in' | 'mail' | 'storage' | 'ai-provider' | 'server-plugins' | 'shares' | 'accounts' | 'log'
export type AreaSlug = AccountSlug | ServerSlug | 'about'
export type AreaGroup = 'account' | 'server'

/** `own`: an area of nexlore alone, its title and line under `settings.areas.<key>` of nexlore's words. The rest take
 * theirs from the kit; "KI-Anbieter" only its title. */
export type Area = { slug: AreaSlug; group: AreaGroup; icon: IconLike; own?: boolean; key: string }

/** In the order of the navigation (plan "Einstellungen", "Reihenfolge Mein Konto" and "Reihenfolge Server"). */
export const AREAS: Area[] = [
  { slug: 'profile', group: 'account', icon: 'UserRound', key: 'profile' },
  { slug: 'security', group: 'account', icon: 'ShieldCheck', key: 'security' },
  { slug: 'appearance', group: 'account', icon: 'Palette', key: 'appearance' },
  { slug: 'notes', group: 'account', icon: BookOpen, own: true, key: 'notes' },
  { slug: 'spaces', group: 'account', icon: FolderTree, own: true, key: 'spaces' },
  { slug: 'plugins', group: 'account', icon: Puzzle, own: true, key: 'plugins' },
  // "KI" under My account (E61, the shared module ki 0.1.0): "KI für mich", the own access, what went out.
  { slug: 'ai', group: 'account', icon: Sparkles, own: true, key: 'ai' },
  { slug: 'notifications', group: 'account', icon: 'Bell', key: 'notifications' },
  { slug: 'connections', group: 'account', icon: 'Plug', key: 'connections' },
  { slug: 'general', group: 'server', icon: 'SlidersHorizontal', key: 'general' },
  { slug: 'sign-in', group: 'server', icon: 'KeyRound', key: 'signIn' },
  { slug: 'mail', group: 'server', icon: 'Mail', key: 'mail' },
  { slug: 'storage', group: 'server', icon: 'HardDrive', key: 'storage' },
  { slug: 'ai-provider', group: 'server', icon: Sparkles, own: true, key: 'aiProvider' },
  { slug: 'server-plugins', group: 'server', icon: Puzzle, own: true, key: 'serverPlugins' },
  { slug: 'shares', group: 'server', icon: Globe, own: true, key: 'shares' },
  { slug: 'accounts', group: 'server', icon: 'Users', key: 'accounts' },
  { slug: 'log', group: 'server', icon: 'ScrollText', key: 'log' },
]

export const GROUPS: AreaGroup[] = ['account', 'server']

/** "Über nexlore": an area of every account, below the groups (its `group` only says who may open it). */
export const ABOUT_AREA: Area = { slug: 'about', group: 'account', icon: 'Info', key: 'about' }

export function findArea(slug: AreaSlug): Area | undefined {
  return slug === ABOUT_AREA.slug ? ABOUT_AREA : AREAS.find((area) => area.slug === slug)
}

/** The areas an account may open: the operator all, a member those of its own account. */
export function areasFor(role: Role | undefined): Area[] {
  return role === 'operator' ? AREAS : AREAS.filter((area) => area.group === 'account')
}

/** The shared cards of Server › Allgemein in nexlore, in their order (ui 1.1.3, U-3): the line under the title names only
 * these ("Grenzen", "Funktionen für alle Konten", "Schnittstellen", "Andere nex-Apps", "Sprachen"). */
export const GENERAL_PARTS: readonly GeneralPart[] = ['limits', 'features', 'interfaces', 'nexApps', 'languages']

export function areaPath(slug: AreaSlug): string {
  return `/settings/${slug}`
}

/** The tabs of "My account" before (`/account?tab=…`). */
const FORMER_ACCOUNT: Record<string, AreaSlug> = {
  profile: 'profile',
  security: 'security',
  notify: 'notifications',
  ai: 'ai',
  plugins: 'plugins',
}

/** The anchors of "My account" before (`/account#ai`): the card they named, in its area now. */
const FORMER_ANCHOR: Record<string, AreaSlug> = {
  '#ai': 'ai',
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
  extensions: 'ai-provider',
  files: 'general',
  backups: 'storage',
  languages: 'general',
  log: 'log',
}

/** Where the cards of the area "AI, API and plugins" (`/settings/extensions`, until the settings pass) went, by the
 * anchor of the card: the AI for everybody under AI provider, the interfaces under General, plugins of their own. */
const FORMER_EXTENSIONS: Record<string, AreaSlug> = {
  '#ai': 'ai-provider',
  '#api-tokens': 'general',
  '#mcp': 'general',
  '#app-pairing': 'general',
  '#calendar': 'general',
  '#plugins': 'server-plugins',
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
 * area the account may not open, which goes to the profile). `/settings` alone shows the profile (and on a phone the
 * list).
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
    const former = tab === 'server' && sub ? (sub === 'extensions' && FORMER_EXTENSIONS[hash]) || FORMER_PART[sub] : FORMER_TAB[tab]
    if (former && open(former)) return { redirect: areaPath(former) + hash }
    return { redirect: areaPath('profile') }
  }
  if (asked === 'extensions') {
    const former = FORMER_EXTENSIONS[hash] ?? 'ai-provider'
    return { redirect: open(former) ? areaPath(former) + hash : areaPath('profile') }
  }
  if (asked === ABOUT_AREA.slug || open(asked as AreaSlug)) return { area: asked as AreaSlug }
  return { redirect: areaPath('profile') }
}
