/**
 * The second factor of the own account: set up (scan the code, type one code and the password), new recovery codes,
 * turn off. Recovery codes are shown once, right after they were made, to copy or save as a file. Accounts that sign
 * in through a provider bring the provider's second factor and see only a line saying so.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, totpApi, type Me, type TotpEnrolment } from '../api/client'
import { errorText } from '../lib/errors'
import { useAuth } from '../state/auth'
import { Field, Problem } from './AuthFrame'
import { Symbol } from './Symbol'

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

const QUIET = 'rounded-full border border-ink-700 px-3 py-1 text-xs hover:bg-ink-850 disabled:opacity-50'
const LOUD = 'rounded-full bg-accent-500 px-4 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-50'

export function SecondFactor({ me }: { me: Me }) {
  const { t } = useTranslation()
  const { refresh } = useAuth()
  const [enrolment, setEnrolment] = useState<TotpEnrolment | null>(null)
  const [asking, setAsking] = useState<'disable' | 'renew' | null>(null)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  if (me.sign_in !== 'password') return <p className="text-sm text-mist-400">{t('twofactor.provider')}</p>

  const close = () => {
    setEnrolment(null)
    setAsking(null)
    setCode('')
    setPassword('')
    setProblem(null)
  }

  const act = async (work: () => Promise<void>) => {
    setBusy(true)
    setProblem(null)
    try {
      await work()
    } catch (error) {
      setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
    } finally {
      setBusy(false)
    }
  }

  const codesText = (codes ?? []).join('\n')

  return (
    <div className="space-y-3 text-sm" data-testid="second-factor">
      <p className="text-mist-400">{t('twofactor.lead')}</p>
      <Problem text={problem} />

      {codes ? (
        <div className="space-y-3 rounded-xl border border-accent-500/40 bg-accent-500/10 p-3" data-testid="recovery-codes">
          <p className="font-semibold text-mist-100">{t('twofactor.codesTitle')}</p>
          <p className="text-xs text-mist-400">{t('twofactor.codesLead')}</p>
          <ol className="grid grid-cols-2 gap-2 rounded-lg bg-ink-950 px-4 py-3 font-mono text-sm text-mist-100">
            {codes.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={QUIET}
              onClick={() => void navigator.clipboard?.writeText(codesText).then(() => setCopied(true), () => undefined)}
            >
              {copied ? t('mcp.copied') : t('twofactor.codesCopy')}
            </button>
            <button type="button" className={QUIET} onClick={() => saveAsFile(`nexlore-recovery-codes-${me.name}.txt`, codesText + '\n')}>
              {t('twofactor.codesDownload')}
            </button>
            <button
              type="button"
              className={LOUD}
              onClick={() => {
                setCodes(null)
                setCopied(false)
                void refresh()
              }}
            >
              {t('twofactor.codesDone')}
            </button>
          </div>
        </div>
      ) : enrolment ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            void act(async () => {
              const result = await totpApi.confirm(code.trim(), password)
              close()
              setCodes(result.recovery_codes)
            })
          }}
        >
          <p className="text-mist-300">{t('twofactor.scan')}</p>
          <div className="flex justify-center">
            <img
              src={'data:image/svg+xml;utf8,' + encodeURIComponent(enrolment.qr_svg)}
              alt={t('twofactor.qr')}
              width={196}
              height={196}
              className="rounded-lg"
            />
          </div>
          <p className="text-xs text-mist-500">{t('twofactor.secret')}</p>
          <code className="block rounded-lg bg-ink-950 px-3 py-2 font-mono text-xs break-all text-mist-200" data-testid="totp-secret">
            {enrolment.secret.replace(/(.{4})/g, '$1 ').trim()}
          </code>
          <Field label={t('twofactor.code')} value={code} onChange={setCode} autoComplete="one-time-code" autoFocus />
          <Field label={t('auth.password')} value={password} onChange={setPassword} type="password" autoComplete="current-password" hint={t('twofactor.passwordHint')} />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={close} className="rounded-full px-3 py-1 text-sm text-mist-400">
              {t('common.cancel')}
            </button>
            <button type="submit" disabled={busy || code.trim().length !== 6 || !password} className={LOUD}>
              {t('twofactor.confirm')}
            </button>
          </div>
        </form>
      ) : asking ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            void act(async () => {
              if (asking === 'disable') {
                await totpApi.disable(password)
                close()
                await refresh()
              } else {
                const result = await totpApi.recovery(password)
                close()
                setCodes(result.recovery_codes)
              }
            })
          }}
        >
          <p className="text-mist-300">{asking === 'disable' ? t('twofactor.disableText') : t('twofactor.renewText')}</p>
          <Field label={t('auth.password')} value={password} onChange={setPassword} type="password" autoComplete="current-password" autoFocus />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={close} className="rounded-full px-3 py-1 text-sm text-mist-400">
              {t('common.cancel')}
            </button>
            <button type="submit" disabled={busy || !password} className={asking === 'disable' ? 'rounded-full bg-bad-500 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50' : LOUD}>
              {asking === 'disable' ? t('twofactor.disable') : t('twofactor.renew')}
            </button>
          </div>
        </form>
      ) : me.two_factor ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1.5 text-mist-200">
            <Symbol name="shield" className="h-4 w-4 text-ok-500" />
            {t('twofactor.on', { count: me.two_factor_recovery_left })}
          </span>
          <button type="button" className={QUIET} onClick={() => setAsking('renew')}>
            {t('twofactor.renew')}
          </button>
          <button type="button" className={QUIET} onClick={() => setAsking('disable')}>
            {t('twofactor.disable')}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-mist-400">{t('twofactor.off')}</span>
          <button type="button" disabled={busy} className={LOUD} onClick={() => void act(async () => setEnrolment(await totpApi.begin()))}>
            {t('twofactor.enable')}
          </button>
        </div>
      )}
      {!codes && me.two_factor && me.two_factor_recovery_left < LOW_CODES && (
        <p role="note" className="rounded-lg border border-warn-500/40 bg-warn-500/10 px-3 py-2 text-xs text-warn-500">
          {t('twofactor.lowCodes')}
        </p>
      )}
    </div>
  )
}
