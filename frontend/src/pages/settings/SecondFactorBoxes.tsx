/**
 * Two parts of the module's security page (`PAGES`, konten 0.3.6): the second factor, its state beside the heading
 * ("On"/"Off", `SECOND_FACTOR_STATE`), set up (scan the code, type one code and the password) and remove; then the
 * recovery codes, how many are left, and new ones. A setup that waits for its first code comes back after a reload
 * (`GET /api/auth/totp/setup`, `factor.pending_setup`). Recovery codes are shown once, right after they were made, to
 * copy or save as a file. Accounts that sign in through a provider bring the provider's second factor and see only a
 * line saying so. Also the only content of the page an account sees while the operator requires a second factor it
 * has not set up yet.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { totpApi, type Me, type TotpEnrolment } from '../../api/client'
import { AccountButton } from '../../components/AccountButton'
import { confirmOf } from '../../lib/accountButton'
import { problemText } from '../../lib/errors'
import { copyText } from '../../lib/vaultActions'
import { useAuth } from '../../state/auth'
import { SECOND_FACTOR_STATE } from '../../vendor/nexkonten/konten'
import { Badge, Box, ConfirmDialog, Field, Notice } from '../../vendor/nexui'
import { pagePart } from './accountPages'

/** Below this many recovery codes the account is told to make new ones. */
const LOW_CODES = 3

function saveAsFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export function SecondFactor({ me }: { me: Me }) {
  const { t } = useTranslation()
  const { refresh } = useAuth()
  const [enrolment, setEnrolment] = useState<TotpEnrolment | null>(null)
  const [asking, setAsking] = useState<'disable' | 'renew' | null>(null)
  const [digits, setDigits] = useState('')
  const [password, setPassword] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (me.sign_in !== 'password' || me.two_factor) return
    let live = true
    totpApi.waiting().then(
      (held) => {
        if (live && held.waiting && held.secret && held.uri && held.qr_svg) setEnrolment({ secret: held.secret, uri: held.uri, qr_svg: held.qr_svg, expires_at: held.expires_at })
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [me.sign_in, me.two_factor])

  const factor = pagePart('security', 'secondFactor')
  const recovery = pagePart('security', 'recoveryCodes')
  const state = SECOND_FACTOR_STATE[(me.factor_state ?? (me.two_factor ? 'active' : 'none')) as keyof typeof SECOND_FACTOR_STATE] ?? SECOND_FACTOR_STATE.none

  const close = () => {
    setEnrolment(null)
    setAsking(null)
    setDigits('')
    setPassword('')
    setProblem(null)
  }

  const act = async (work: () => Promise<void>) => {
    setBusy(true)
    setProblem(null)
    try {
      await work()
    } catch (error) {
      setProblem(problemText(error))
    } finally {
      setBusy(false)
    }
  }

  const codesText = (codes ?? []).join('\n')
  const left = me.two_factor_recovery_left

  return (
    <>
      <Box
        title={t(factor.title)}
        badge={
          <Badge tone={state === SECOND_FACTOR_STATE.active ? 'on' : 'off'} testId="second-factor-state">
            {t(state)}
          </Badge>
        }
        hint={t(factor.hint)}
        testId="second-factor"
        actions={
          me.sign_in === 'password' && !enrolment ? (
            me.two_factor ? (
              <AccountButton name="account.totpRemove" onClick={() => setAsking('disable')} />
            ) : (
              <AccountButton name="account.totpSetup" disabled={busy} onClick={() => void act(async () => setEnrolment(await totpApi.begin()))} />
            )
          ) : undefined
        }
      >
        {me.sign_in !== 'password' ? (
          <p className="m-0 text-sm text-[var(--nexui-text-muted)]">{t('twofactor.provider')}</p>
        ) : enrolment ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void act(async () => {
                const result = await totpApi.confirm(digits.trim(), password)
                close()
                setCodes(result.recovery_codes)
              })
            }}
          >
            <p className="m-0 text-sm">{t('twofactor.scan')}</p>
            <div className="flex justify-center">
              <img src={'data:image/svg+xml;utf8,' + encodeURIComponent(enrolment.qr_svg)} alt={t('twofactor.qr')} width={196} height={196} className="rounded-[9px] bg-white p-2" />
            </div>
            <p className="m-0 text-xs text-[var(--nexui-text-muted)]">{t('twofactor.secret')}</p>
            <code className="block rounded-[9px] bg-[var(--nexui-field)] px-3 py-2 font-mono text-xs break-all" data-testid="totp-secret">
              {enrolment.secret.replace(/(.{4})/g, '$1 ').trim()}
            </code>
            <Field label={t('twofactor.code')} value={digits} onChange={(event) => setDigits(event.target.value)} autoComplete="one-time-code" autoFocus mono />
            <Field label={t('account.password')} value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" hints={[t('twofactor.passwordHint')]} />
            {problem && <Notice tone="danger">{problem}</Notice>}
            <div className="flex flex-wrap gap-2">
              <AccountButton name="cancel" onClick={close}>
                {t('common.cancel')}
              </AccountButton>
              <AccountButton name="confirm" type="submit" disabled={busy || digits.trim().length !== 6 || !password}>
                {t('twofactor.confirm')}
              </AccountButton>
            </div>
          </form>
        ) : (
          problem && asking === null && <Notice tone="danger">{problem}</Notice>
        )}
      </Box>
      {asking === 'disable' && (
        <ConfirmDialog
          title={t('account.totpRemove')}
          text={t('twofactor.disableText')}
          confirm={confirmOf('account.totpRemove', t('account.totpRemove'))}
          cancel={t('common.cancel')}
          closeLabel={t('common.close')}
          busy={busy}
          error={problem}
          confirmDisabled={!password}
          onCancel={close}
          onConfirm={() =>
            void act(async () => {
              await totpApi.disable(password)
              close()
              await refresh()
            })
          }
        >
          <Field label={t('account.password')} value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" />
        </ConfirmDialog>
      )}

      {me.sign_in === 'password' && (me.two_factor || codes) && (
        <Box
          title={t(recovery.title)}
          badge={!codes && <Badge tone={left < LOW_CODES ? 'warn' : 'off'}>{t('account.recoveryLeft', { count: left })}</Badge>}
          hint={t(recovery.hint)}
          testId="recovery-part"
          actions={!codes && <AccountButton name="account.recoveryCodesNew" onClick={() => setAsking('renew')} />}
        >
          {codes ? (
            <div className="flex flex-col gap-3" data-testid="recovery-codes">
              <Notice tone="warn" title={t('twofactor.codesTitle')}>
                {t('twofactor.codesLead')}
              </Notice>
              <ol className="m-0 grid list-none grid-cols-2 gap-2 rounded-[9px] bg-[var(--nexui-field)] px-4 py-3 font-mono text-sm">
                {codes.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ol>
              <div className="flex flex-wrap gap-2">
                <AccountButton name="copy" onClick={() => void copyText(codesText).then(setCopied)}>
                  {copied ? t('common.copied') : t('twofactor.codesCopy')}
                </AccountButton>
                <AccountButton name="download" onClick={() => saveAsFile(`nexlore-recovery-codes-${me.name}.txt`, codesText + '\n')}>
                  {t('twofactor.codesDownload')}
                </AccountButton>
                <AccountButton
                  name="done"
                  onClick={() => {
                    setCodes(null)
                    setCopied(false)
                    void refresh()
                  }}
                >
                  {t('twofactor.codesDone')}
                </AccountButton>
              </div>
            </div>
          ) : (
            me.two_factor && left < LOW_CODES && <Notice tone="warn">{t('twofactor.lowCodes')}</Notice>
          )}
        </Box>
      )}
      {asking === 'renew' && (
        <ConfirmDialog
          title={t('account.recoveryCodesNew')}
          text={t('twofactor.renewText')}
          confirm={confirmOf('account.recoveryCodesNew', t('account.recoveryCodesNew'))}
          cancel={t('common.cancel')}
          closeLabel={t('common.close')}
          busy={busy}
          error={problem}
          confirmDisabled={!password}
          onCancel={close}
          onConfirm={() =>
            void act(async () => {
              const result = await totpApi.recovery(password)
              close()
              setCodes(result.recovery_codes)
            })
          }
        >
          <Field label={t('account.password')} value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" />
        </ConfirmDialog>
      )}
    </>
  )
}
