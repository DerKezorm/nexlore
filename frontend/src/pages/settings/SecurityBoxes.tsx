/**
 * Parts of "Sign-in and security" that came with the shared account module (part 2): the passkeys, "Where you are
 * signed in", and after a password set through a link "These devices still have access" with "Disconnect all". Built
 * from the shared kit (`vendor/nexui`: `Box`, `Row`, `ConfirmDialog`, `Notice`) as in nexmail, words from `account.*`,
 * every button of the module through `AccountButton`.
 */
import { Fingerprint, Monitor, Smartphone } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { authApi, passkeysApi, type AccessEntry, type PasskeyEntry, type SessionEntry } from '../../api/client'
import { AccountButton } from '../../components/AccountButton'
import { confirmOf } from '../../lib/accountButton'
import { problemText } from '../../lib/errors'
import { dayTime } from '../../lib/when'
import { addPasskey, passkeysSupported } from '../../lib/passkeys'
import { PasskeyAddition } from '../../vendor/nexkonten/AccountCards'
import { Badge, Box, ConfirmDialog, Field, Notice as Message, Row, Rows } from '../../vendor/nexui'

/** A success worth a sentence that is not the usual "saved" (thrown to end an action early). */
// eslint-disable-next-line react-refresh/only-export-components
export class Notice extends Error {}

/** The own passkeys: list, add (password first), remove. */
export function PasskeysBox({ signedInByPassword, canAdd, operator }: { signedInByPassword: boolean; canAdd: boolean; operator: boolean }) {
  const { t, i18n } = useTranslation()
  const [keys, setKeys] = useState<PasskeyEntry[] | null>(null)
  const [asking, setAsking] = useState<{ kind: 'add' } | { kind: 'remove'; uid: string } | null>(null)
  const [password, setPassword] = useState('')
  const [label, setLabel] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    passkeysApi.list().then(setKeys, () => setKeys([]))
  }, [])
  useEffect(load, [load])
  if (keys === null) return null
  const act = async () => {
    if (!asking) return
    setBusy(true)
    setProblem(null)
    try {
      if (asking.kind === 'add') await addPasskey(password, label.trim())
      else await passkeysApi.remove(asking.uid, password)
      setAsking(null)
      setPassword('')
      setLabel('')
      load()
    } catch (error) {
      setProblem(error instanceof Error && error.message === 'passkey_cancelled' ? null : problemText(error))
    } finally {
      setBusy(false)
    }
  }
  const adding = asking?.kind === 'add'
  return (
    <Box
      title={t('account.passkeys')}
      hint={t('account.passkeysHint')}
      testId="passkeys"
      // The button, or (in the box) what is missing for it without a public https address (konten E49); the list
      // of passkeys stays, shown and removable.
      actions={passkeysSupported() && canAdd && <PasskeyAddition t={t} canAdd operator={operator} busy={busy} onAdd={() => setAsking({ kind: 'add' })} />}
    >
      {passkeysSupported() && !canAdd && <PasskeyAddition t={t} canAdd={false} operator={operator} onAdd={() => undefined} />}
      {keys.length > 0 && (
        <Rows label={t('account.passkeys')}>
          {keys.map((key) => (
            <Row
              key={key.uid}
              icon={Fingerprint}
              name={key.name || t('account.passkeys')}
              detail={dayTime(key.last_used_at ?? key.created_at, i18n.language)}
              action={<AccountButton name="account.passkeyRemove" onClick={() => setAsking({ kind: 'remove', uid: key.uid })} />}
            />
          ))}
        </Rows>
      )}
      {asking && (
        <ConfirmDialog
          title={adding ? t('account.passkeyAdd') : t('account.passkeyRemove')}
          text={signedInByPassword ? undefined : t('account.confirmFresh')}
          confirm={adding ? confirmOf('account.passkeyAdd', t('account.passkeyAdd')) : confirmOf('account.passkeyRemove', t('account.passkeyRemove'))}
          cancel={t('common.cancel')}
          closeLabel={t('common.close')}
          busy={busy}
          error={problem}
          confirmDisabled={signedInByPassword && !password}
          onCancel={() => setAsking(null)}
          onConfirm={() => void act()}
        >
          {adding && <Field label={t('account.passkeyName')} value={label} onChange={(event) => setLabel(event.target.value)} maxLength={100} />}
          {signedInByPassword && <Field label={t('account.currentPassword')} value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" />}
        </ConfirmDialog>
      )}
    </Box>
  )
}

/** "Signed-in devices" (``account.sessions``, konten 0.3.6): browsers and paired devices, this browser marked, each
 * signed out alone; under them what "Sign out everywhere else" ends and what stays, and the button. */
export function SessionsBox({ onEverywhere, busy = false }: { onEverywhere: () => Promise<unknown>; busy?: boolean }) {
  const { t, i18n } = useTranslation()
  const [rows, setRows] = useState<SessionEntry[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const load = useCallback(() => {
    authApi.sessions().then(setRows, () => setRows([]))
  }, [])
  useEffect(load, [load])
  if (rows === null) return null
  return (
    <Box
      title={t('account.sessions')}
      hint={t('account.signOutEverywhereHint')}
      testId="sessions"
      actions={<AccountButton name="account.signOutEverywhere" disabled={busy} testId="sign-out-everywhere" onClick={() => void onEverywhere().then(load)} />}
    >
      <Rows label={t('account.sessions')}>
        {rows.map((row) => (
          <Row
            key={row.uid}
            icon={row.device ? Smartphone : Monitor}
            name={<span title={row.label}>{row.device ? `${t('account.sessionDevice')}: ${row.label}` : row.label || t('account.sessions')}</span>}
            badge={row.current ? <Badge tone="on">{t('account.sessionThis')}</Badge> : undefined}
            detail={row.current ? undefined : dayTime(row.last_seen_at ?? row.created_at, i18n.language)}
            action={
              !row.current && (
                <AccountButton
                  name="account.sessionSignOut"
                  onClick={() => {
                    setProblem(null)
                    authApi.endSession(row.uid).then(load, (error) => setProblem(problemText(error)))
                  }}
                />
              )
            }
          />
        ))}
      </Rows>
      {problem && <Message tone="danger">{problem}</Message>}
    </Box>
  )
}

/** After a password set through a link: what still has access, "Disconnect all", or put the list away. */
export function RemainingAccess({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<AccessEntry[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    authApi.access().then((answer) => setEntries(answer.access), () => setEntries([]))
  }, [])
  if (entries === null) return null
  const finish = (call: () => Promise<unknown>) => {
    setProblem(null)
    call().then(onDone, (error) => setProblem(problemText(error)))
  }
  return (
    <Message tone="warn" title={entries.length > 0 ? t('account.remainingAccess') : t('account.resetByOperator')} testId="remaining-access">
      {entries.length > 0 && (
        <ul className="m-0 list-disc pl-5">
          {entries.map((entry) => (
            <li key={`${entry.kind}-${entry.id}`}>{entry.label}</li>
          ))}
        </ul>
      )}
      {problem && <p className="m-0 mt-2 text-[var(--nexui-danger)]">{problem}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {entries.length > 0 && <AccountButton name="account.disconnectAll" onClick={() => finish(() => authApi.disconnectAll())} />}
        <AccountButton name="done" onClick={() => finish(() => authApi.accessSeen())}>
          {t('common.done')}
        </AccountButton>
      </div>
    </Message>
  )
}

/** The emergency hammer is down (``NEXLORE_SECOND_FACTOR_OFF``, the shared module's ``NOTICES``): said plainly at the
 * top of the own account and of the operator's sign-in settings, as long as the server says so. */
export function SecondFactorOffNotice({ on }: { on?: boolean }) {
  const { t } = useTranslation()
  if (!on) return null
  return (
    <Message tone="warn" title={t('account.secondFactorOff')} testId="second-factor-off">
      {t('account.secondFactorOffHint')}
    </Message>
  )
}
