/** nexlore's side of the operator's account list of the shared account module (konten 0.3.9/0.3.10): what its server
 * can do, and its rows as the module knows them. */
import type { AdminAccount } from '../../api/client'
import type { AccountCaps, ListedAccount, OwnAction } from '../../vendor/nexkonten/konten'

/** What nexlore's server can do for the operator (`ACCOUNT_CAPS`). Deleting is for good in nexlore, so there is
 * nothing to bring back (`restore` off); an invitation into nexlore has no role, rights come per space
 * (`inviteRole` off). */
export const APP_CAPS: AccountCaps = {
  rename: true,
  roles: true,
  inviteRole: false,
  emailRemove: true,
  resetLink: true,
  factorReset: true,
  signOut: true,
  unlink: true,
  blocking: true,
  remove: true,
  restore: false,
}

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
    deletedAt: null,
    purgeAt: null,
    lastSeenAt: row.last_seen_at,
    picture: avatarUrl(row.id, row.avatar),
  }
}
