/**
 * Settings, Server, Sign-in: three cards one below the other, as the shared sign-in blueprint lays them out for every
 * nex app (part 04). Order, wording and behaviour come from there; the parts (card, switch, field, button, question)
 * are nexlore's own.
 *
 * 1. Sign-in: password sign-in (locked on while no provider is active), the public address, the second factor.
 * 2. Sign-in providers: the list with its marks, the drag handle, and the form as a dialog.
 * 3. authentik in one step: address, token, "Set up", the blueprint, and the steps with the reason of a failure.
 */
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'

import {
  ApiError,
  adminApi,
  type AuthentikResult,
  type OidcProvider,
  type OidcProviderForm,
  type ServerSettings,
} from '../../api/client'
import { errorText } from '../../lib/errors'
import { authentikReasonKey, authentikStepKey, oidcErrorKey, oidcFormErrorKey, slugFromLabel } from '../../vendor/nexoidc/oidc'
import { ConfirmDialog } from '../ConfirmDialog'
import { Symbol } from '../Symbol'
import { Button, Card, CopyLink, Feedback, Input, Toggle } from './ui'
import { useAction } from './useAction'

/** The whole part: the list is loaded once and shared, the button changes it too. */
export function SignInPart({ settings, onChange }: { settings: ServerSettings; onChange: (next: ServerSettings) => void }) {
  const [providers, setProviders] = useState<OidcProvider[] | null>(null)
  const load = useCallback(async () => setProviders(await adminApi.providers()), [])
  useEffect(() => {
    void load().catch(() => setProviders([]))
  }, [load])
  const active = (providers ?? []).some((entry) => entry.enabled)
  const coupled = (providers ?? []).some((entry) => entry.managed === 'nexsuite')
  return (
    <>
      <SignInCard settings={settings} onChange={onChange} anyActive={active} />
      <ProvidersCard providers={providers} reload={load} publicUrl={settings.public_url} />
      <AuthentikCard publicUrl={settings.public_url} coupled={coupled} reload={load} />
    </>
  )
}

// --- Card 1: sign-in -------------------------------------------------------------------------------------------------

export function SignInCard({
  settings,
  onChange,
  anyActive,
}: {
  settings: ServerSettings
  onChange: (next: ServerSettings) => void
  anyActive: boolean
}) {
  const { t } = useTranslation()
  const [address, setAddress] = useState(settings.public_url)
  const { busy, problem, done, run } = useAction()

  // The switch moves at once; the server's answer confirms it, a refusal puts it back.
  const save = (change: Partial<ServerSettings>) => {
    onChange({ ...settings, ...change })
    void run(async () => onChange(await adminApi.saveSettings(change)), t('common.saved')).then((ok) => ok || onChange(settings))
  }

  return (
    <Card id="sign-in" symbol="shield" title={t('oidc.admin.signInTitle')}>
      <div className="space-y-3">
        <Toggle
          label={t('oidc.admin.password')}
          hint={t('oidc.admin.passwordHint')}
          checked={settings.password_login}
          // Without an active provider nobody but the operator could come in: the switch stays on.
          disabled={settings.password_login && !anyActive}
          onChange={(value) => save({ password_login: value })}
        />
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            save({ public_url: address })
          }}
        >
          <Input
            label={t('oidc.admin.address')}
            value={address}
            onChange={setAddress}
            placeholder="https://notes.example.com"
            hint={t('oidc.admin.addressHint')}
            className="min-w-60 flex-1"
          />
          <Button type="submit" busy={busy}>
            {t('common.save')}
          </Button>
        </form>
        <Toggle
          label={t('admin.signIn.twoFactor')}
          hint={t('admin.signIn.twoFactorHint')}
          checked={settings.two_factor_required}
          onChange={(value) => save({ two_factor_required: value })}
        />
      </div>
      <Feedback problem={problem} done={done} />
    </Card>
  )
}

// --- Card 2: the provider list ---------------------------------------------------------------------------------------

/** The same issuer, however written at the end (the server's `same_issuer` for an issuer without a placeholder). */
function sameIssuer(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '')
}

export function ProvidersCard({
  providers,
  reload,
  publicUrl,
}: {
  providers: OidcProvider[] | null
  reload: () => Promise<void>
  publicUrl: string
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState<OidcProvider | 'new' | null>(null)
  const [removing, setRemoving] = useState<{ entry: OidcProvider; count: number; only: number } | null>(null)
  const [dragged, setDragged] = useState<number | null>(null)
  const { busy, problem, done, run } = useAction()
  const list = providers ?? []
  const readOnly = list.some((entry) => !entry.editable)

  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= list.length) return
    const ids = list.map((entry) => entry.id)
    const [taken] = ids.splice(from, 1)
    ids.splice(to, 0, taken)
    void run(async () => {
      await adminApi.orderProviders(ids)
      await reload()
    })
  }

  return (
    <Card id="sign-in-providers" symbol="key" title={t('oidc.admin.providersTitle')} text={t('oidc.admin.providersText')}>
      {providers !== null && list.length === 0 && <p className="text-sm text-mist-400">{t('oidc.admin.empty')}</p>}
      {list.length > 0 && (
        <ul className="divide-y divide-ink-700 rounded-xl border border-ink-700" data-testid="provider-list">
          {list.map((entry, index) => (
            <li
              key={entry.id}
              className={`flex flex-wrap items-center gap-2 px-3 py-3 text-sm ${dragged === index ? 'opacity-50' : ''}`}
              draggable={!readOnly}
              onDragStart={() => setDragged(index)}
              onDragEnd={() => setDragged(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                if (dragged !== null) move(dragged, index)
                setDragged(null)
              }}
            >
              {!readOnly && list.length > 1 && (
                <button
                  type="button"
                  className="cursor-grab rounded p-1 text-mist-500 hover:text-mist-200"
                  aria-label={t('admin.providers.order', { name: entry.label })}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowUp') move(index, index - 1)
                    if (event.key === 'ArrowDown') move(index, index + 1)
                  }}
                >
                  <Symbol name="grip" className="h-4 w-4" />
                </button>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{entry.label}</span>
                <span className="block truncate text-xs text-mist-500">{entry.issuer}</span>
              </span>
              <span className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className={`rounded-full px-2 ${entry.enabled ? 'bg-ok-500/10 text-ok-500' : 'border border-ink-700 text-mist-400'}`}>
                  {entry.enabled ? t('oidc.admin.active') : t('oidc.admin.inactive')}
                </span>
                {entry.managed === 'authentik' && (
                  <span className="rounded-full border border-accent-500/40 px-2 text-accent-400">{t('oidc.admin.managed')}</span>
                )}
                {entry.managed === 'nexsuite' && (
                  <span className="rounded-full border border-accent-500/40 px-2 text-accent-400">{t('admin.providers.coupled')}</span>
                )}
              </span>
              {entry.editable && (
                <span className="flex gap-1.5">
                  <Button small onClick={() => setEditing(entry)}>
                    {t('oidc.admin.edit')}
                  </Button>
                  <Button
                    small
                    danger
                    busy={busy}
                    onClick={() =>
                      void run(async () => {
                        const impact = await adminApi.providerImpact(entry.id)
                        setRemoving({ entry, count: impact.count, only: impact.only })
                      })
                    }
                  >
                    {t('oidc.admin.remove')}
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="mt-3">
          <Button primary onClick={() => setEditing('new')}>
            {t('oidc.admin.add')}
          </Button>
        </div>
      )}
      <Feedback problem={problem} done={done} />
      {editing !== null && (
        <ProviderDialog
          entry={editing === 'new' ? null : editing}
          publicUrl={publicUrl}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await reload()
          }}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        title={t('oidc.admin.remove')}
        confirm={t('oidc.admin.remove')}
        danger
        busy={busy}
        onCancel={() => setRemoving(null)}
        onConfirm={() =>
          void run(async () => {
            await adminApi.removeProvider(removing!.entry.id)
            setRemoving(null)
            await reload()
          })
        }
      >
        {removing && t('oidc.admin.removeConfirm', { name: removing.entry.label, count: removing.count, only: removing.only })}
      </ConfirmDialog>
    </Card>
  )
}

const EMPTY: OidcProviderForm = {
  label: '',
  slug: '',
  issuer: '',
  client_id: '',
  client_secret: '',
  scopes: 'openid profile email',
  enabled: true,
  auto_create: false,
  trusts_second_factor: true,
}

type FieldName = 'label' | 'slug' | 'issuer' | 'client_id' | 'client_secret' | 'scopes' | 'id'

/** The provider form as a dialog, fields in the blueprint's order. */
function ProviderDialog({
  entry,
  publicUrl,
  onClose,
  onSaved,
}: {
  entry: OidcProvider | null
  publicUrl: string
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [form, setForm] = useState<OidcProviderForm>(
    entry
      ? {
          label: entry.label,
          issuer: entry.issuer,
          client_id: entry.client_id,
          client_secret: '',
          scopes: entry.scopes,
          enabled: entry.enabled,
          auto_create: entry.auto_create,
          trusts_second_factor: entry.trusts_second_factor,
        }
      : EMPTY,
  )
  // The short name follows the name on the button until it is typed itself.
  const [slugTyped, setSlugTyped] = useState(false)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [fieldError, setFieldError] = useState<{ field: FieldName; text: string } | null>(null)
  const [confirmIssuer, setConfirmIssuer] = useState<number | null>(null)

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])

  const slug = entry ? entry.slug : slugTyped ? form.slug ?? '' : slugFromLabel(form.label)
  const base = (publicUrl || window.location.origin).replace(/\/+$/, '')
  const redirect = entry ? entry.redirect_uri : `${base}/api/oidc/${slug || '…'}/callback`

  const set = (change: Partial<OidcProviderForm>) => setForm((current) => ({ ...current, ...change }))

  const errorFor = (error: unknown): { field: FieldName; text: string } => {
    if (!(error instanceof ApiError)) return { field: 'id', text: errorText('internal_error') }
    const field = (typeof error.values.field === 'string' ? error.values.field : 'id') as FieldName
    const key = oidcFormErrorKey(error.code) ?? oidcErrorKey(error.code)
    return { field, text: key ? t(key) : errorText(error.code, error.values) }
  }

  const save = async () => {
    setBusy(true)
    setFieldError(null)
    try {
      const body = { ...form, slug: entry ? undefined : slug }
      if (entry) await adminApi.saveProvider(entry.id, body)
      else await adminApi.addProvider(body)
      await onSaved()
    } catch (error) {
      setFieldError(errorFor(error))
    } finally {
      setBusy(false)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    // Another issuer is another provider: say first how many accounts will have to link again.
    if (entry && entry.links > 0 && !sameIssuer(entry.issuer, form.issuer)) {
      try {
        const impact = await adminApi.providerImpact(entry.id, form.issuer.trim())
        if (impact.issuer_change > 0) return setConfirmIssuer(impact.issuer_change)
      } catch (error) {
        return setFieldError(errorFor(error))
      }
    }
    await save()
  }

  const hint = (field: FieldName) => (fieldError?.field === field ? fieldError.text : undefined)

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
      className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-2xl border border-ink-700 bg-ink-900 p-0 text-mist-200 shadow-2xl backdrop:bg-scrim"
    >
      <form className="space-y-3 p-5" onSubmit={(event) => void submit(event)} data-testid="provider-form">
        <h2 id={titleId} className="text-base font-semibold text-mist-100">
          {entry ? `${t('oidc.admin.edit')}: ${entry.label}` : t('oidc.admin.add')}
        </h2>
        <Input label={t('oidc.admin.label')} value={form.label} onChange={(label) => set({ label })} />
        {fieldError?.field === 'label' && <FieldProblem text={fieldError.text} />}
        {entry ? (
          <p className="text-xs text-mist-500">
            {t('oidc.admin.slug')}: <code className="font-mono text-mist-300">{entry.slug}</code>
          </p>
        ) : (
          <>
            <Input
              label={t('oidc.admin.slug')}
              value={slug}
              onChange={(value) => {
                setSlugTyped(true)
                set({ slug: value })
              }}
              hint={t('oidc.admin.slugHint')}
            />
            {fieldError?.field === 'slug' && <FieldProblem text={fieldError.text} />}
          </>
        )}
        <Input
          label={t('oidc.admin.issuer')}
          value={form.issuer}
          onChange={(issuer) => set({ issuer })}
          placeholder="https://auth.example.com/application/o/nexlore/"
          hint={t('oidc.admin.issuerHint')}
        />
        {hint('issuer') && <FieldProblem text={hint('issuer')!} />}
        <Input label={t('oidc.admin.clientId')} value={form.client_id} onChange={(client_id) => set({ client_id })} />
        {hint('client_id') && <FieldProblem text={hint('client_id')!} />}
        <Input
          label={t('oidc.admin.secret')}
          value={form.client_secret}
          onChange={(client_secret) => set({ client_secret })}
          type="password"
          placeholder={entry?.has_secret ? t('oidc.admin.secretKept') : ''}
        />
        {hint('client_secret') && <FieldProblem text={hint('client_secret')!} />}
        <div className="text-sm">
          <span className="text-xs font-medium text-mist-400">{t('oidc.admin.redirect')}</span>
          <div className="mt-1">
            <CopyLink link={redirect} label={t('admin.providers.copy')} />
          </div>
        </div>
        <Toggle label={t('oidc.admin.enabled')} checked={form.enabled} onChange={(enabled) => set({ enabled })} />
        <Toggle
          label={t('oidc.admin.autoCreate')}
          hint={t('oidc.admin.autoCreateHint')}
          checked={form.auto_create}
          onChange={(auto_create) => set({ auto_create })}
        />
        <Toggle
          label={t('oidc.admin.trustsSecondFactor')}
          hint={t('oidc.admin.trustsSecondFactorHint')}
          checked={form.trusts_second_factor}
          onChange={(trusts_second_factor) => set({ trusts_second_factor })}
        />
        <details open={more || fieldError?.field === 'scopes'} onToggle={(event) => setMore((event.target as HTMLDetailsElement).open)}>
          <summary className="cursor-pointer text-xs text-mist-400">{t('admin.providers.more')}</summary>
          <div className="mt-2">
            <Input label={t('oidc.admin.scopes')} value={form.scopes} onChange={(scopes) => set({ scopes })} />
            {hint('scopes') && <FieldProblem text={hint('scopes')!} />}
          </div>
        </details>
        {fieldError?.field === 'id' && <FieldProblem text={fieldError.text} />}
        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onClose} busy={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" primary busy={busy}>
            {t('common.save')}
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirmIssuer !== null}
        title={t('oidc.admin.issuer')}
        confirm={t('common.save')}
        danger
        busy={busy}
        onCancel={() => setConfirmIssuer(null)}
        onConfirm={() => {
          setConfirmIssuer(null)
          void save()
        }}
      >
        {t('oidc.admin.issuerChangeConfirm', { count: confirmIssuer ?? 0 })}
      </ConfirmDialog>
    </dialog>
  )
}

function FieldProblem({ text }: { text: string }) {
  return (
    <p role="alert" className="-mt-1 text-xs text-bad-500">
      {text}
    </p>
  )
}

// --- Card 3: authentik in one step ------------------------------------------------------------------------------------

export function AuthentikCard({ publicUrl, coupled, reload }: { publicUrl: string; coupled: boolean; reload: () => Promise<void> }) {
  const { t } = useTranslation()
  const [authentik, setAuthentik] = useState({ url: '', token: '' })
  const [steps, setSteps] = useState<AuthentikResult | null>(null)
  const { busy, problem, run } = useAction()

  return (
    <Card id="sign-in-authentik" symbol="sparkle" title={t('oidc.authentik.title')} text={t('oidc.authentik.text')}>
      {coupled && <p className="mb-3 text-sm text-warn-500">{t('oidc.authentik.why.coupled')}</p>}
      {!publicUrl && !coupled && (
        <p className="mb-3 rounded-lg border border-warn-500/30 bg-warn-500/10 px-3 py-2 text-xs text-warn-500" data-testid="authentik-no-address">
          {t('oidc.authentik.noAddress')}{' '}
          <a href="#sign-in" className="underline">
            {t('oidc.admin.address')}
          </a>
        </p>
      )}
      <form
        className="grid gap-2 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (coupled) return
          setSteps(null)
          void run(async () => {
            setSteps(await adminApi.authentik(authentik.url, authentik.token))
            setAuthentik((current) => ({ ...current, token: '' }))
            await reload()
          })
        }}
      >
        <Input label={t('oidc.authentik.url')} value={authentik.url} onChange={(url) => setAuthentik({ ...authentik, url })} placeholder="https://auth.example.com" />
        <Input label={t('oidc.authentik.token')} value={authentik.token} onChange={(token) => setAuthentik({ ...authentik, token })} type="password" />
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
          <Button type="submit" primary busy={busy || coupled}>
            {t('oidc.authentik.run')}
          </Button>
          {coupled ? (
            <span className="text-sm text-mist-500">{t('oidc.authentik.blueprint')}</span>
          ) : (
            <a href="/api/oidc/authentik/blueprint" className="text-sm text-accent-400 hover:underline">
              {t('oidc.authentik.blueprint')}
            </a>
          )}
        </div>
      </form>
      {busy && <p className="mt-3 text-xs text-mist-400" aria-live="polite">{t('oidc.authentik.asking')}</p>}
      {steps && (
        <ol className="mt-3 space-y-1.5 text-sm" data-testid="authentik-steps">
          {steps.steps.map((step) => {
            const name = authentikStepKey(step.key)
            const why = step.ok ? null : authentikReasonKey(step.reason)
            return (
              <li key={step.key} className="flex gap-2">
                <span className={step.ok ? 'text-ok-500' : 'text-bad-500'} aria-hidden="true">
                  {step.ok ? '✓' : '✗'}
                </span>
                <span>
                  <span className={step.ok ? 'text-mist-200' : 'font-medium text-bad-500'}>{name ? t(name) : step.key}</span>
                  {why && <span className="block text-xs text-mist-400">{t(why, { status: step.status ?? 0 })}</span>}
                </span>
              </li>
            )
          })}
        </ol>
      )}
      <Feedback problem={problem} />
    </Card>
  )
}
