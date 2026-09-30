/**
 * Who is in a space and with which right, and invitations into it. A manager changes everything here; the operator
 * opens it to reset rights of a space it does not read (then without inviting).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { showModalOnce } from '../lib/dialog'

import { authApi, type Members, type NewInvite, type Role } from '../api/client'
import { formatDay } from '../lib/markdown'
import { useAuth } from '../state/auth'
import { useStore } from '../state/store'
import { Button, CopyLink, Feedback, Input, Select } from './settings/ui'
import { useAction } from './settings/useAction'
import { Symbol } from './Symbol'

const ROLES: Role[] = ['read', 'write', 'manage']
const DAYS = ['1', '7', '30'] as const

export function MembersDialog({ space, onClose }: { space: string; onClose: () => void }) {
  const { t } = useTranslation()
  const { me } = useAuth()
  const dialog = useRef<HTMLDialogElement>(null)
  const [data, setData] = useState<Members | null>(null)
  const [person, setPerson] = useState('')
  const [personRole, setPersonRole] = useState<Role>('read')
  const [inviteRole, setInviteRole] = useState<Role>('write')
  const [days, setDays] = useState<(typeof DAYS)[number]>('7')
  const [email, setEmail] = useState('')
  const [send, setSend] = useState(false)
  const [made, setMade] = useState<NewInvite | null>(null)
  const { busy, problem, run } = useAction()
  const { reload } = useStore()
  /** Giving up the last right to manage, asked once more: after it only the operator can manage the space. */
  const [lastManager, setLastManager] = useState<{ role: Role | null } | null>(null)
  const [invitedName, setInvitedName] = useState<string | null>(null)

  const load = useCallback(() => run(async () => setData(await authApi.members(space))), [run, space])

  useEffect(() => {
    showModalOnce(dialog.current)
    void load()
  }, [load])

  const manages = data?.role === 'manage'
  const managers = data?.members.filter((member) => member.role === 'manage').length ?? 0

  /** The own right changes (``role``) or the own membership ends (``null``). */
  const changeOwn = (role: Role | null, asked = false) => {
    if (!asked && managers === 1 && role !== 'manage') {
      setLastManager({ role })
      return
    }
    setLastManager(null)
    void run(async () => {
      if (role === null) await authApi.removeMember(space, me?.name ?? '')
      else await authApi.setMember(space, me?.name ?? '', role)
      // Without the right to manage the list is not readable any more: close instead of showing an error.
      if (role === null || (role !== 'manage' && me?.role !== 'operator')) {
        await reload()
        onClose()
      } else await load()
    })
  }
  const roleOptions = ROLES.map((role) => ({ value: role, label: t(`roles.${role}`) }))

  return (
    <dialog
      ref={dialog}
      aria-labelledby="members-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-2xl border border-ink-700 bg-ink-900 p-0 text-mist-200 shadow-2xl backdrop:bg-scrim"
    >
      <div className="max-h-[85vh] overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 id="members-title" className="text-base font-semibold text-mist-100">
            {t('members.title', { space })}
          </h2>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="rounded-full p-1 text-mist-500 hover:bg-ink-850">
            <Symbol name="close" />
          </button>
        </div>
        {!manages && data && <p className="mt-1 text-xs text-mist-500">{t('members.resetOnly')}</p>}

        <ul className="mt-4 divide-y divide-ink-700 rounded-xl border border-ink-700">
          {data?.members.map((member) => (
            <li key={member.name} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium">
                {member.name}
                {member.you && <span className="ml-2 text-xs text-mist-500">{t('members.you')}</span>}
              </span>
              <label className="sr-only" htmlFor={`role-${member.name}`}>
                {t('members.roleOf', { name: member.name })}
              </label>
              <select
                id={`role-${member.name}`}
                value={member.role}
                disabled={busy}
                onChange={(event) => {
                  const role = event.target.value as Role
                  if (member.you) return changeOwn(role)
                  void run(async () => {
                    await authApi.setMember(space, member.name, role)
                    await load()
                  })
                }}
                className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-xs"
              >
                {roleOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <Button
                small
                danger
                busy={busy}
                label={member.you ? t('members.leave') : t('members.remove', { name: member.name })}
                onClick={() => {
                  if (member.you) return changeOwn(null)
                  void run(async () => {
                    await authApi.removeMember(space, member.name)
                    await load()
                  })
                }}
              >
                {member.you ? t('members.leave') : t('members.removeShort')}
              </Button>
            </li>
          ))}
          {data && data.members.length === 0 && <li className="px-4 py-3 text-sm text-mist-500">{t('members.none')}</li>}
        </ul>
        {lastManager && (
          <div role="alert" className="mt-3 rounded-xl border border-warn-500/30 bg-warn-500/10 px-4 py-3 text-sm">
            <p>{lastManager.role === null ? t('members.lastManagerLeave') : t('members.lastManagerRole')}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button small danger busy={busy} onClick={() => changeOwn(lastManager.role, true)}>
                {lastManager.role === null ? t('members.leaveAnyway') : t('members.changeAnyway')}
              </Button>
              <Button small onClick={() => setLastManager(null)}>{t('common.cancel')}</Button>
            </div>
          </div>
        )}

        <form
          className="mt-4 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!person.trim()) return
            const name = person.trim()
            setInvitedName(null)
            void run(async () => {
              const answer = await authApi.setMember(space, name, personRole)
              setPerson('')
              if (answer.invited) setInvitedName(name)
              await load()
            })
          }}
        >
          <Input label={t('members.addName')} value={person} onChange={setPerson} className="min-w-40 flex-1" />
          <Select label={t('members.role')} value={personRole} options={roleOptions} onChange={setPersonRole} />
          <Button type="submit" busy={busy}>
            {manages ? t('members.inviteName') : t('members.add')}
          </Button>
        </form>
        {invitedName && <p role="status" className="mt-2 text-xs text-mist-400">{t('members.invitedName', { name: invitedName })}</p>}

        {manages && (
          <div className="mt-6 border-t border-ink-700 pt-4">
            <h3 className="text-sm font-semibold">{t('members.invite.title')}</h3>
            <p className="mt-0.5 text-xs text-mist-500">{t('members.invite.text')}</p>
            <form
              className="mt-3 grid gap-2 sm:grid-cols-3"
              onSubmit={(event) => {
                event.preventDefault()
                void run(async () => {
                  setMade(await authApi.inviteToSpace(space, inviteRole, Number(days), email.trim(), send))
                  await load()
                })
              }}
            >
              <Select label={t('members.role')} value={inviteRole} options={roleOptions} onChange={setInviteRole} />
              <Select
                label={t('members.invite.valid')}
                value={days}
                options={DAYS.map((value) => ({ value, label: t('members.invite.days', { count: Number(value) }) }))}
                onChange={setDays}
              />
              <Input label={t('members.invite.email')} value={email} onChange={setEmail} type="email" />
              {me?.mail && (
                <label className="flex items-center gap-2 text-xs text-mist-400 sm:col-span-2">
                  <input type="checkbox" checked={send} onChange={(event) => setSend(event.target.checked)} className="accent-accent-500" />
                  {t('members.invite.send')}
                </label>
              )}
              <div className="sm:col-span-3">
                <Button type="submit" primary busy={busy}>
                  <Symbol name="link" /> {t('members.invite.create')}
                </Button>
              </div>
            </form>
            {made && (
              <div className="mt-3 space-y-1">
                <CopyLink link={made.link} label={t('members.invite.copy')} />
                <p className="text-xs text-mist-500">{made.sent ? t('members.invite.sent', { email: made.email }) : t('members.invite.once')}</p>
              </div>
            )}
            {data && data.invites.length > 0 && (
              <ul className="mt-4 divide-y divide-ink-700 rounded-xl border border-ink-700 text-xs">
                {data.invites.map((invite) => (
                  <li key={invite.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
                    <span className="flex-1">
                      {t(`roles.${invite.role}`)}
                      {invite.email && ` · ${invite.email}`} · {t('members.invite.until', { when: formatDay(invite.expires_at) })}
                    </span>
                    <Button small danger busy={busy} onClick={() => void run(async () => {
                      await authApi.withdrawInvite(invite.id)
                      await load()
                    })}>
                      {t('members.invite.withdraw')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <Feedback problem={problem} />
      </div>
    </dialog>
  )
}
