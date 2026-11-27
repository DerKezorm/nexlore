/**
 * Settings › "Accounts", the operator's list as the shared account module lays it out (konten 0.3.9/0.3.10,
 * `ACCOUNT_LIST`): one row per account with its picture, name, badges and "username · email", and "Manage" on the
 * right, which opens a dialog with every fact and every act in words (`MANAGE_DIALOG`: change, access, end). Never a
 * word of anybody's notes. The operator never sets another account's password or address: a link lets the person set
 * a new password themselves, an address can only be taken away.
 *
 * What nexlore adds sits at the module's fixed places: the spaces the account has a right in and what it uploaded as
 * facts; deleting is for good in nexlore and says what goes ("Its rights go with it, its notes stay; a space it was
 * alone in is yours then", with the names of those spaces). The open invitations into nexlore are the module's card
 * under the list (expired ones stay until withdrawn). The card "All spaces" with the rights dialog stays a card of its
 * own under them (`AllSpacesCard`).
 */
import { Mail, Users } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { adminApi, authApi, type AccountImpact, type AdminAccount, type FactorResetOverview, type Invite } from '../../api/client'
import { AccountButton } from '../../components/AccountButton'
import { confirmOf } from '../../lib/accountButton'
import { DEVICES_API, deviceRequest } from '../../lib/devicesModule'
import { problemText } from '../../lib/errors'
import { copyText } from '../../lib/vaultActions'
import { bytes, day, dayTime } from '../../lib/when'
import { useAuth } from '../../state/auth'
import {
  ACCOUNT_LIST,
  accountActions,
  accountBadges,
  accountCount,
  accountFacts,
  accountLine,
  accountName,
  accountPicture,
  confirmLine,
  DISPLAY_NAME_MAX,
  FACTOR_RESET_DEFAULTS,
  factorResetParts,
  INVITE_DIALOG,
  inviteFields,
  inviteRow,
  linkSubmit,
  MANAGE_CONFIRM,
  MANAGE_DIALOG,
  manageGroups,
  OPEN_INVITES,
  RESET_DAYS,
  RESET_DAYS_DEFAULT,
  RESET_LINK_DIALOG,
  removeLines,
  STORAGE_LIMIT_DIALOG,
  storageFact,
  USERNAME_MAX,
  type AccountAction,
  type BadgeShown,
  type FactShown,
  type ListedAccount,
  type ListedInvite,
} from '../../vendor/nexkonten/konten'
import { AccountDevicesPart } from '../../vendor/nexgeraete'
import { Avatar, Badge, Button, ButtonGroup, Buttons, Card, CheckboxRow, ConfirmDialog, Dialog, Facts, Field, Notice, Row, Rows, SelectField, type IconName } from '../../vendor/nexui'
import { APP_CAPS, APP_OWN_ACTIONS, listedOf } from './accountList'

/** One running action at a time, with its problem as a sentence and an optional success line. */
function useAct() {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const run = useCallback(async (action: () => Promise<unknown>, success: string | null = null) => {
    setBusy(true)
    setProblem(null)
    setDone(null)
    try {
      await action()
      setDone(success)
      return true
    } catch (error) {
      setProblem(problemText(error))
      return false
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, problem, done, run }
}

function Said({ problem, done = null }: { problem: string | null; done?: string | null }) {
  return (
    <div aria-live="polite" className="flex flex-col gap-2 empty:hidden">
      {problem && <Notice tone="danger">{problem}</Notice>}
      {done && <Notice tone="ok">{done}</Notice>}
    </div>
  )
}

/** The badges of a row or an invitation, in the kit's look; a day in nexlore's way of writing it. */
function Badges({ shown }: { shown: BadgeShown[] }) {
  const { t, i18n } = useTranslation()
  return (
    <>
      {shown.map((badge, index) => (
        <Badge key={`${badge.badge}-${index}`} tone={badge.tone}>
          {badge.label ?? t(badge.text, badge.date ? { day: day(badge.date, i18n.language) } : undefined)}
        </Badge>
      ))}
    </>
  )
}

/** The picture of an account: its own, else the letter on the hue of its name (the same on server and iPhone). */
function Picture({ row, size }: { row: ListedAccount; size: 32 | 48 }) {
  const picture = accountPicture(row)
  return <Avatar src={picture.src} letter={picture.letter} hue={picture.hue} color={picture.color} size={size} />
}

export function AccountsCard() {
  const { t } = useTranslation()
  const { me } = useAuth()
  const [rows, setRows] = useState<AdminAccount[] | null>(null)
  const [invites, setInvites] = useState<Invite[]>([])
  const [inviting, setInviting] = useState(false)
  const [managing, setManaging] = useState<number | null>(null)
  const [withdrawing, setWithdrawing] = useState<Invite | null>(null)
  const action = useAct()

  const load = useCallback(() => {
    adminApi.accounts().then(setRows, () => setRows([]))
    authApi.invites().then(setInvites, () => undefined)
  }, [])
  useEffect(load, [load])

  if (!rows || !me) return null
  // The operator's own account first, the others as the server orders them.
  const ordered = [...rows.filter((row) => row.id === me.id), ...rows.filter((row) => row.id !== me.id)]
  const listed = ordered.map((row) => listedOf(row, me.id))
  const open = managing === null ? null : (ordered.find((row) => row.id === managing) ?? null)

  return (
    <div className="space-y-6">
      <Card id="accounts" icon={Users} title={t(ACCOUNT_LIST.title)} subtitle={t(ACCOUNT_LIST.subtitle, { count: accountCount(listed) })} testId="account-list">
        <div>
          <AccountButton name="account.invite" testId="invite-open" onClick={() => setInviting(true)} />
        </div>
        <Rows label={t(ACCOUNT_LIST.title)} testId="account-rows">
          {listed.map((row) => (
            <Row
              key={row.id}
              testId={`account-${row.username}`}
              lead={<Picture row={row} size={32} />}
              name={accountName(row)}
              badge={<Badges shown={accountBadges(row)} />}
              sub={accountLine(row)}
              action={
                <AccountButton name="account.manage" aria-label={t(ACCOUNT_LIST.manageLabel, { name: accountName(row) })} testId="account-manage" onClick={() => setManaging(Number(row.id))}>
                  {t(ACCOUNT_LIST.manage)}
                </AccountButton>
              }
            />
          ))}
        </Rows>
        <Said problem={action.problem} done={action.done} />
      </Card>

      {invites.length > 0 && (
        <Card id="invites" icon={Mail} title={t(OPEN_INVITES.title)} testId="open-invites">
          <Rows label={t(OPEN_INVITES.title)} testId="invite-list">
            {invites.map((invite) => {
              const shown = inviteRow(inviteOf(invite))
              return (
                <Row
                  key={invite.id}
                  testId="invite-row"
                  icon={Mail}
                  name={shown.name || t(shown.nameText)}
                  badge={<Badges shown={shown.badges} />}
                  sub={shown.sub || undefined}
                  action={<AccountButton name="account.inviteWithdraw" onClick={() => setWithdrawing(invite)} />}
                />
              )
            })}
          </Rows>
        </Card>
      )}

      {open && (
        <ManageDialog
          row={open}
          listed={listedOf(open, me.id)}
          operatorHasPassword={me.sign_in === 'password'}
          mailServer={Boolean(me.mail)}
          onClose={() => setManaging(null)}
          onChanged={load}
          onGone={() => {
            setManaging(null)
            load()
          }}
        />
      )}
      {inviting && <InviteDialog onClose={() => setInviting(false)} onMade={load} />}
      {withdrawing && (
        <ConfirmDialog
          title={t('account.inviteWithdraw')}
          text={t(MANAGE_CONFIRM['account.inviteWithdraw'].text)}
          confirm={confirmOf('account.inviteWithdraw', t('account.inviteWithdraw'))}
          cancel={t('common.cancel')}
          closeLabel={t('common.close')}
          busy={action.busy}
          onCancel={() => setWithdrawing(null)}
          onConfirm={() =>
            void action.run(async () => {
              await authApi.withdrawInvite(withdrawing.id)
              setWithdrawing(null)
              load()
            }, t('admin.accounts.withdrawn'))
          }
        />
      )}
    </div>
  )
}

/** An invitation of nexlore's answer as the module's list knows it (an invitation into nexlore has no role). */
function inviteOf(invite: Invite): ListedInvite {
  return {
    id: invite.id,
    displayName: invite.display_name ?? '',
    email: invite.email,
    expiresAt: invite.expires_at,
    ...(invite.expired !== undefined ? { expired: invite.expired } : {}),
  }
}

/** An act of the dialog waiting for its confirmation. */
type Pending = { action: Extract<AccountAction, { type: 'button' }>; impact?: AccountImpact; overview?: FactorResetOverview | null }

/** The dialog "Manage" (`MANAGE_DIALOG`): the head with picture, name, badges and line; the facts with nexlore's
 * spaces and uploads; then the groups with their buttons in words. Each act asks as `MANAGE_CONFIRM` says. */
function ManageDialog({ row, listed, operatorHasPassword, mailServer, onClose, onChanged, onGone }: {
  row: AdminAccount
  listed: ListedAccount
  operatorHasPassword: boolean
  mailServer: boolean
  onClose: () => void
  onChanged: () => void
  onGone: () => void
}) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const name = accountName(listed)
  const action = useAct()
  const [pending, setPending] = useState<Pending | null>(null)
  const [naming, setNaming] = useState<'name' | 'display_name' | null>(null)
  const [resetting, setResetting] = useState(false)

  const [limiting, setLimiting] = useState(false)
  const own: FactShown[] = [
    { fact: 'spaces', label: 'admin.accounts.spacesFact', raw: String(row.spaces ?? 0) },
    // The storage of the account against its own limit (konten 1.1.0, set right here with "Storage limit").
    storageFact(listed, (value) => bytes(value, lang)),
  ]
  const facts = accountFacts(listed, own).map((fact) => ({
    label: t(fact.label),
    value: (
      <>
        {fact.raw ?? (fact.date ? dayTime(fact.date, lang) : fact.text ? t(fact.text, fact.values) : '')}
        {fact.state && <span className="text-[var(--nexui-text-muted)]"> · {t(fact.state)}</span>}
      </>
    ),
    note: fact.note ? t(fact.note) : undefined,
    testId: `fact-${fact.fact}`,
  }))
  // The last provider of an account without a password stays linked, as in 1.16.0: unlinking it would lock the account
  // out, and the server refuses it anyway (``oidc_only_account``).
  const lastLink = !listed.hasPassword && listed.providers.length <= 1
  const groups = manageGroups(
    accountActions(listed, APP_CAPS, APP_OWN_ACTIONS).filter(
      (act) => !(lastLink && act.type === 'button' && act.name.startsWith('account.unlinkProvider')),
    ),
  )

  const start = (act: Extract<AccountAction, { type: 'button' }>) => {
    const base = act.name.split(':')[0]
    if (base === 'account.changeUsername') return setNaming('name')
    if (base === 'account.changeDisplayName') return setNaming('display_name')
    if (base === 'account.resetLink') return setResetting(true)
    if (base === 'account.storageLimit') return setLimiting(true)
    if (base === 'account.remove') {
      return void adminApi.impact(row.id).then(
        (impact) => setPending({ action: act, impact }),
        () => setPending({ action: act }),
      )
    }
    if (base === 'account.factorReset') {
      return void adminApi.resetOverview(row.id).then(
        (overview) => setPending({ action: act, overview }),
        () => setPending({ action: act, overview: null }),
      )
    }
    setPending({ action: act })
  }

  return (
    <>
      <Dialog title={t(MANAGE_DIALOG.title, { name })} onClose={onClose} closeLabel={t('common.close')} testId="manage-dialog">
        <div className="flex flex-col gap-4">
          <Rows>
            <Row lead={<Picture row={listed} size={48} />} name={name} badge={<Badges shown={accountBadges(listed)} />} sub={accountLine(listed)} />
          </Rows>
          <Facts items={facts} label={t(MANAGE_DIALOG.title, { name })} testId="manage-facts" />
          {/* The account's devices (module geraete): how many, which, last seen, "Disconnect devices". */}
          <AccountDevicesPart request={deviceRequest} base={DEVICES_API} accountId={row.id} name={name} blocked={listed.blocked || Boolean(listed.deletedAt)} language={lang} onChanged={onChanged} />
          {groups.map((group) => (
            <ButtonGroup key={group.group} title={t(group.title)} layout={group.layout} testId={`manage-${group.group}`}>
              {group.actions.map((act) =>
                act.type === 'button' ? (
                  <Button key={act.name} kind={act.kind} icon={act.icon as IconName} disabled={action.busy} onClick={() => start(act)} testId={`manage-${act.name}`}>
                    {t(act.label, act.values)}
                  </Button>
                ) : (
                  <CheckboxRow
                    key={act.name}
                    label={t(act.label)}
                    checked={act.checked}
                    disabled={action.busy || !act.right}
                    onChange={(on) =>
                      act.right &&
                      void action.run(async () => {
                        await adminApi.setRight(row.id, act.right as string, on)
                        onChanged()
                      })
                    }
                  />
                ),
              )}
            </ButtonGroup>
          ))}
          <Said problem={action.problem} done={action.done} />
        </div>
      </Dialog>
      {pending && (
        <ConfirmAct
          row={row}
          name={name}
          pending={pending}
          operatorHasPassword={operatorHasPassword}
          onCancel={() => setPending(null)}
          onDone={(gone) => {
            setPending(null)
            if (gone) onGone()
            else onChanged()
          }}
        />
      )}
      {naming && <NameDialog row={row} field={naming} operatorHasPassword={operatorHasPassword} onClose={() => setNaming(null)} onSaved={onChanged} />}
      {resetting && <ResetLinkDialog row={row} name={name} mailServer={mailServer} operatorHasPassword={operatorHasPassword} onClose={() => setResetting(false)} />}
      {limiting && <StorageLimitDialog row={row} name={name} operatorHasPassword={operatorHasPassword} onClose={() => setLimiting(false)} onSaved={onChanged} />}
    </>
  )
}

/** The question of one act: the act's own words, kind and symbol on the confirming button, the module's sentence
 * (`MANAGE_CONFIRM`), for deleting nexlore's sentence and the spaces it was alone in, for the reset of the second
 * factor its parts (`factorResetParts`); with the operator's own password where it asks for one (`confirmLine`). */
function ConfirmAct({ row, name, pending, operatorHasPassword, onCancel, onDone }: {
  row: AdminAccount
  name: string
  pending: Pending
  operatorHasPassword: boolean
  onCancel: () => void
  onDone: (gone: boolean) => void
}) {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const [disconnect, setDisconnect] = useState<boolean>(FACTOR_RESET_DEFAULTS.factorResetDevices)
  const [removePasskeys, setRemovePasskeys] = useState<boolean>(FACTOR_RESET_DEFAULTS.factorResetPasskeys)
  const action = useAct()
  const act = pending.action
  const base = act.name.split(':')[0] as keyof typeof MANAGE_CONFIRM
  const spec = MANAGE_CONFIRM[base]
  const asksPassword = (spec?.confirm ?? 'password') === 'password'
  const values = { name, provider: act.values?.provider ?? '', email: row.email, app: 'nexlore' }
  const passkeys = pending.overview?.passkeys ?? []

  const lines: ReactNode[] = []
  if (spec?.text && base !== 'account.factorReset') lines.push(<p key="text" className="m-0 text-sm">{t(spec.text, values)}</p>)
  if (base === 'account.remove') {
    lines.push(
      <p key="what" className="m-0 text-sm" data-testid="remove-numbers">
        {t('admin.accounts.removeWhat')}
      </p>,
    )
    if (pending.impact && pending.impact.alone.length > 0) {
      lines.push(
        <p key="alone" className="m-0 text-sm" data-testid="remove-alone">
          {t('admin.accounts.removeAlone', { count: pending.impact.alone.length, spaces: pending.impact.alone.join(', ') })}
        </p>,
      )
    }
    for (const line of removeLines(APP_CAPS)) lines.push(<p key={line} className="m-0 text-sm">{t(line)}</p>)
  }
  if (base === 'account.factorReset') {
    for (const part of factorResetParts({ passkeys })) {
      if (part === 'factorResetHint') lines.push(<p key={part} className="m-0 text-sm">{t('account.factorResetHint')}</p>)
      if (part === 'passkeys') lines.push(<p key={part} className="m-0 text-sm">{t('account.passkeys')}: {passkeys.map((key) => key.name).join(', ')}</p>)
      if (part === 'factorResetPasskeys') lines.push(<CheckboxRow key={part} label={t('account.factorResetPasskeys')} checked={removePasskeys} onChange={setRemovePasskeys} />)
      if (part === 'factorResetDevices') lines.push(<CheckboxRow key={part} label={t('account.factorResetDevices')} checked={disconnect} onChange={setDisconnect} />)
    }
  }
  if (asksPassword) lines.push(<p key="confirm" className="m-0 text-sm text-[var(--nexui-text-muted)]">{t(confirmLine(operatorHasPassword))}</p>)

  return (
    <ConfirmDialog
      title={t(act.label, act.values)}
      confirm={confirmOf(act.button, t(act.label, act.values))}
      cancel={t('common.cancel')}
      closeLabel={t('common.close')}
      busy={action.busy}
      confirmDisabled={asksPassword && operatorHasPassword && !password}
      onCancel={onCancel}
      onConfirm={() =>
        void action.run(async () => {
          let gone = false
          if (base === 'account.makeOperator') await adminApi.setRole(row.id, 'operator', password)
          if (base === 'account.makeMember') await adminApi.setRole(row.id, 'member', password)
          if (base === 'account.emailRemove') await adminApi.removeEmail(row.id, password)
          if (base === 'account.factorReset') await adminApi.resetSecondFactor(row.id, password, disconnect, removePasskeys && passkeys.length > 0)
          if (base === 'account.signOutAccount') await adminApi.signOutAccount(row.id)
          if (base === 'account.unlinkProvider' && act.provider) await adminApi.unlinkAccount(row.id, Number(act.provider.id), password)
          if (base === 'account.block') await adminApi.block(row.id, password)
          if (base === 'account.unblock') await adminApi.unblock(row.id, password)
          if (base === 'account.restore') await adminApi.restore(row.id, password)
          if (base === 'account.remove') {
            await adminApi.deleteAccount(row.id, password)
            gone = true
          }
          onDone(gone)
        })
      }
    >
      {lines}
      {asksPassword && operatorHasPassword && (
        <Field label={t('account.currentPassword')} type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
      )}
      <Said problem={action.problem} />
    </ConfirmDialog>
  )
}

/** "Change display name" or "Change username" (the module's fields and hints), with the operator's own password. */
function NameDialog({ row, field, operatorHasPassword, onClose, onSaved }: {
  row: AdminAccount
  field: 'name' | 'display_name'
  operatorHasPassword: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const [value, setValue] = useState(field === 'name' ? row.name : row.display_name)
  const [own, setOwn] = useState('')
  const action = useAct()
  const title = field === 'name' ? t('account.changeUsername') : t('account.changeDisplayName')
  return (
    <Dialog title={title} onClose={onClose} closeLabel={t('common.close')} testId="name-dialog">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void action.run(async () => {
            if (field === 'name') await adminApi.rename(row.id, value.trim(), own)
            else await adminApi.displayName(row.id, value.trim(), own)
            onSaved()
            onClose()
          })
        }}
      >
        {field === 'name' && <p className="m-0 text-sm">{t('account.askChangeUsername', { name: row.display_name || row.name })}</p>}
        <Field
          label={field === 'name' ? t('account.username') : t('account.displayName')}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          maxLength={field === 'name' ? USERNAME_MAX : DISPLAY_NAME_MAX}
          hints={[field === 'name' ? t('account.usernameRules') : t('account.displayNameHint')]}
        />
        <p className="m-0 text-sm text-[var(--nexui-text-muted)]">{t(confirmLine(operatorHasPassword))}</p>
        {operatorHasPassword && <Field label={t('account.currentPassword')} type="password" autoComplete="current-password" value={own} onChange={(event) => setOwn(event.target.value)} />}
        <Said problem={action.problem} />
        <div className="flex flex-wrap justify-end gap-2">
          <AccountButton name="cancel" onClick={onClose}>
            {t('common.cancel')}
          </AccountButton>
          <AccountButton name="account.save" type="submit" disabled={action.busy || (operatorHasPassword && !own) || (field === 'name' && !value.trim())} />
        </div>
      </form>
    </Dialog>
  )
}

/** A link to hand on: the field to read it in and the button that copies it. */
function CopyField({ value, label, hint }: { value: string; label: string; hint?: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1">
        <Field label={label} value={value} readOnly mono hints={hint ? [hint] : undefined} onFocus={(event) => event.target.select()} />
      </div>
      <AccountButton name="copy" onClick={() => void copyText(value).then(setCopied)}>
        {copied ? t('common.copied') : t('common.copy')}
      </AccountButton>
    </div>
  )
}

/** "Link for a new password" (`RESET_LINK_DIALOG`): the operator never sets another account's password; with a mail
 * server and an address that counts the link goes there, else it shows once to hand on. */
function ResetLinkDialog({ row, name, mailServer, operatorHasPassword, onClose }: {
  row: AdminAccount
  name: string
  mailServer: boolean
  operatorHasPassword: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [days, setDays] = useState(String(RESET_DAYS_DEFAULT))
  const [own, setOwn] = useState('')
  const [link, setLink] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const action = useAct()
  const sends = mailServer && Boolean(row.email) && row.email_confirmed !== false
  return (
    <Dialog title={t(RESET_LINK_DIALOG.title)} onClose={onClose} closeLabel={t('common.close')} testId="reset-link-dialog">
      {sent ? (
        <div className="flex flex-col gap-3" data-testid="reset-link">
          <Notice tone="ok">{t(RESET_LINK_DIALOG.sent, { email: row.email, name })}</Notice>
          <div className="flex justify-end">
            <AccountButton name="done" onClick={onClose}>
              {t('common.done')}
            </AccountButton>
          </div>
        </div>
      ) : link ? (
        <div className="flex flex-col gap-3" data-testid="reset-link">
          <p className="m-0 text-sm">{t(RESET_LINK_DIALOG.shown, { name })}</p>
          <CopyField value={link} label={t(RESET_LINK_DIALOG.title)} />
          <div className="flex justify-end">
            <AccountButton name="done" onClick={onClose}>
              {t('common.done')}
            </AccountButton>
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void action.run(async () => {
              const answer = await adminApi.resetLink(row.id, Number(days), own)
              if (answer.sent) setSent(true)
              else setLink(answer.link)
            })
          }}
        >
          <p className="m-0 text-sm">{t(RESET_LINK_DIALOG.text, { name })}</p>
          <SelectField
            label={t(RESET_LINK_DIALOG.days.label)}
            value={days}
            onChange={(event) => setDays(event.target.value)}
            options={RESET_DAYS.map((value) => ({ value: String(value), label: t('account.days', { count: value }) }))}
          />
          <p className="m-0 text-sm text-[var(--nexui-text-muted)]">{t(confirmLine(operatorHasPassword))}</p>
          {operatorHasPassword && <Field label={t('account.currentPassword')} type="password" autoComplete="current-password" value={own} onChange={(event) => setOwn(event.target.value)} />}
          <Said problem={action.problem} />
          <div className="flex flex-wrap justify-end gap-2">
            <AccountButton name="cancel" onClick={onClose}>
              {t('common.cancel')}
            </AccountButton>
            <AccountButton name={linkSubmit(sends)} type="submit" disabled={action.busy || (operatorHasPassword && !own)} />
          </div>
        </form>
      )}
    </Dialog>
  )
}

/** "Invite a person" into nexlore (`INVITE_DIALOG`): the address, the display name, how long it holds, "Send by mail"
 * only with a mail server and an address; afterwards always the link to copy. No username (the person picks it) and no
 * role: rights come per space (an invitation into a space is in the space's members). */
function InviteDialog({ onClose, onMade }: { onClose: () => void; onMade: () => void }) {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [days, setDays] = useState(String(INVITE_DIALOG.days.default))
  const [send, setSend] = useState(true)
  const [made, setMade] = useState<{ link: string; sent: boolean; email: string; expires: string } | null>(null)
  const action = useAct()
  const fields = inviteFields(APP_CAPS, { mailServer: Boolean(me?.mail), email })
  const sends = fields.includes('sendMail') && send
  return (
    <Dialog title={t(INVITE_DIALOG.title)} onClose={onClose} closeLabel={t('common.close')} testId="invite-dialog">
      {made ? (
        <div className="flex flex-col gap-3">
          {made.sent && (
            <Notice tone="ok" testId="invite-sent">
              {t(INVITE_DIALOG.done.sent, { email: made.email })}
            </Notice>
          )}
          <CopyField value={made.link} label={t(INVITE_DIALOG.done.link)} hint={t(INVITE_DIALOG.done.linkHint, { day: day(made.expires, i18n.language) })} />
          <div className="flex justify-end">
            <AccountButton name="done" onClick={onClose}>
              {t('common.done')}
            </AccountButton>
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void action.run(async () => {
              const answer = await authApi.invite(Number(days), email.trim(), sends, displayName.trim())
              setMade({ link: answer.link, sent: answer.sent, email: email.trim(), expires: answer.expires_at })
              onMade()
            })
          }}
        >
          {fields.includes('email') && <Field label={t('account.email')} type="email" value={email} onChange={(event) => setEmail(event.target.value)} hints={[t(INVITE_DIALOG.emailHint)]} />}
          {fields.includes('displayName') && <Field label={t('account.displayName')} value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={DISPLAY_NAME_MAX} />}
          {fields.includes('days') && (
            <SelectField
              label={t(INVITE_DIALOG.days.label)}
              value={days}
              onChange={(event) => setDays(event.target.value)}
              options={INVITE_DIALOG.days.options.map((value) => ({ value: String(value), label: t('account.days', { count: value }) }))}
            />
          )}
          {fields.includes('sendMail') && <CheckboxRow label={t(INVITE_DIALOG.sendMail)} checked={send} onChange={setSend} />}
          <Said problem={action.problem} />
          <div className="flex flex-wrap justify-end gap-2">
            <AccountButton name="cancel" onClick={onClose}>
              {t('common.cancel')}
            </AccountButton>
            <AccountButton name={linkSubmit(sends)} type="submit" testId="invite-submit" disabled={action.busy} />
          </div>
        </form>
      )}
    </Dialog>
  )
}


/** "Storage limit" of the dialog "Manage" (konten 1.1.0, ``STORAGE_LIMIT_DIALOG``): the limit in GB, with the operator's
 * own password; "Remove the limit" lets the account upload without one. */
function StorageLimitDialog({ row, name, operatorHasPassword, onClose, onSaved }: {
  row: AdminAccount
  name: string
  operatorHasPassword: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const { t, i18n } = useTranslation()
  const [value, setValue] = useState(row.storage_limit ? String(Math.round((row.storage_limit / 1024 ** 3) * 100) / 100) : '')
  const [password, setPassword] = useState('')
  const action = useAct()
  const save = (limit: number | null) =>
    void action.run(async () => {
      await adminApi.setStorageLimit(row.id, limit, password)
      onSaved()
      onClose()
    })
  const gigabytes = Number(value.replace(',', '.'))
  const valid = Number.isFinite(gigabytes) && gigabytes > 0
  return (
    <Dialog title={t(STORAGE_LIMIT_DIALOG.title, { name })} onClose={onClose} closeLabel={t('common.close')} testId="storage-limit-dialog">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (valid) save(Math.round(gigabytes * 1024 ** 3))
        }}
      >
        <p className="m-0 text-sm">{t(STORAGE_LIMIT_DIALOG.used, { used: bytes(row.storage_used ?? 0, i18n.language) })}</p>
        <Field label={t(STORAGE_LIMIT_DIALOG.field)} inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} data-testid="storage-limit-field" />
        {operatorHasPassword && (
          <Field label={t('account.currentPassword')} type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        )}
        <Said problem={action.problem} />
        <Buttons end>
          {row.storage_limit ? (
            <AccountButton name={STORAGE_LIMIT_DIALOG.remove} disabled={action.busy || (operatorHasPassword && !password)} onClick={() => save(null)} />
          ) : null}
          <AccountButton name={STORAGE_LIMIT_DIALOG.save} type="submit" disabled={action.busy || !valid || (operatorHasPassword && !password)} />
        </Buttons>
      </form>
    </Dialog>
  )
}
