/** nexlore's side of the operator's account list of the shared account module (konten 0.3.9/0.3.10): what its server
 * can do, and its rows as the module knows them. */
import type { AdminAccount } from '../../api/client'
import { capsOf, type AccountCaps, type ListedAccount, type OwnAction } from '../../vendor/nexkonten/konten'

/** What nexlore's server can do for the operator: its own switches, the module's standard ones (several operators,
 * blocking, deleting with 30 days to bring back) and its features (storage limit and AI per account, konten 1.1.0).
 * An invitation into nexlore has no role, rights come per space (`inviteRole` off). */
export const APP_CAPS: AccountCaps = capsOf('nexlore', {
  rename: true,
  inviteRole: false,
  emailRemove: true,
  resetLink: true,
  factorReset: true,
  signOut: true,
  unlink: true,
})

/** nexlore has no act of its own in the dialog "Manage": its spaces and their rights are the card "All spaces" below
 * the list. */
export const APP_OWN_ACTIONS: readonly OwnAction[] = []

/** The picture of an account, by the version in its address. */
export function avatarUrl(id: number, avatar: string | null | undefined): string | null {
  return avatar ? `/api/avatars/${id}?v=${encodeURIComponent(avatar)}` : null
}

/** One row of nexlore's answer as the module's list knows it (the names of the interface stay). */
export function listedOf(row: AdminAccount, ownId: number | undefined): ListedAccount {
  return {
    id: row.id,
    username: row.name,
    displayName: row.display_name,
    email: row.email,
    emailConfirmed: row.email_confirmed ?? true,
    emailDuplicate: row.email_duplicate ?? false,
    operator: row.role === 'operator',
    self: row.id === ownId,
    hasPassword: row.has_password ?? row.sign_in === 'password',
    authenticator: row.two_factor,
    passkeys: row.passkeys ?? 0,
    providers: row.providers.map((provider) => ({ id: provider.id, label: provider.label })),
    blocked: row.blocked ?? false,
    blockedAt: row.blocked_at ?? null,
    locked: row.locked,
    deletedAt: row.deleted_at ?? null,
    purgeAt: row.purge_at ?? null,
    storageLimit: row.storage_limit ?? null,
    storageUsed: row.storage_used ?? 0,
    rights: row.ai_allowed === false ? [] : ['ai'],
    lastSeenAt: row.last_seen_at,
    picture: avatarUrl(row.id, row.avatar),
  }
}
