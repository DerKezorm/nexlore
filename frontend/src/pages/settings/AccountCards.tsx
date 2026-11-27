/**
 * Settings, "My account": Profile and Security as the shared account module lays them out (`PAGES`, konten 0.3.6: its
 * parts top to bottom, one under the other, with its headings, hints and buttons), then nexlore's own parts after them
 * (`APP_PAGES`: "Sign out" of this browser in the profile; the providers in Security).
 *
 * Built only from the shared kit (`vendor/nexui`, bauplaene/ui), as in nexnotes and every other nex app: every topic a
 * `Box` in its card, every button of the module through `AccountButton` (kind and symbol from `BUTTONS`). The colours
 * are nexlore's (`--nexui-*` in `styles/index.css`).
 */
import { KeyRound, LogOut, ShieldCheck, UserRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { authApi, type Me, type MyProvider } from '../../api/client'
import { AccountButton } from '../../components/AccountButton'
import { Avatar } from '../../components/Avatar'
import { languageOptions, type LanguageOption } from '../../i18n'
import { confirmOf } from '../../lib/accountButton'
import { errorText, problemText } from '../../lib/errors'
import { rememberName } from '../../lib/people'
import { usePasswordConfirm } from '../../lib/passwordConfirm'
import { day } from '../../lib/when'
import { useAuth } from '../../state/auth'
import { DISPLAY_NAME_MAX, EMAIL_MAX, FIELDS, fieldLabel, PAGES, passwordChanged, screenFields, USERNAME_MAX } from '../../vendor/nexkonten/konten'
import { oidcErrorKey } from '../../vendor/nexoidc/oidc'
import { Badge, Box, Card, CheckboxRow, ConfirmDialog, Field, Notice, Row, Rows, SelectField } from '../../vendor/nexui'
import { pagePart } from './accountPages'
import { SecondFactor } from './SecondFactorBoxes'
import { Notice as Done, PasskeysBox, RemainingAccess, SecondFactorOffNotice, SessionsBox } from './SecurityBoxes'

/** What an action of these cards says afterwards, and the problem it ran into. */
function useCardAction() {
  const { refresh } = useAuth()
  const [done, setDone] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true)
    setProblem(null)
    setDone(null)
    try {
      await action()
      setDone(success || null)
      await refresh()
      return true
    } catch (error) {
      if (error instanceof Done) {
        setDone(error.message)
        await refresh()
        return true
      }
      setProblem(problemText(error))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { done, setDone, problem, setProblem, busy, setBusy, run }
}

function Said({ problem, done }: { problem: string | null; done: string | null }) {
  return (
    <div aria-live="polite" className="space-y-2 empty:hidden">
      {problem && <Notice tone="danger">{problem}</Notice>}
      {done && <Notice tone="ok">{done}</Notice>}
    </div>
  )
}

/** The module's profile: picture, display name, username, email (with one button "Save", the password asked for a new
 * username or address), the provider's address on offer, the language, the role small at the end. */
export function ProfileCard({ me }: { me: Me }) {
  const { t } = useTranslation()
  const { setLanguage } = useAuth()
  const action = useCardAction()
  const [name, setName] = useState(me.display_name ?? '')
  const [username, setUsername] = useState(me.name)
  const [email, setEmail] = useState(me.email ?? '')
  /** A new username or address asks for the own password first (the shared account module). */
  const [confirming, setConfirming] = useState(false)
  /** Taking the offered address of a provider asks for the own password first. */
  const [taking, setTaking] = useState(false)
  const [own, setOwn] = useState('')
  const [languages, setLanguages] = useState<LanguageOption[]>([])
  const [linked, setLinked] = useState('')
  useEffect(() => {
    void languageOptions().then(setLanguages)
    authApi.myProviders().then(
      (list) => setLinked(list.find((entry) => entry.linked)?.label ?? ''),
      () => undefined,
    )
  }, [])

  // The provider's name the server kept with the offer (konten 0.3.4); without one the linked provider's, else a word.
  const offerFrom = me.provider_email_from || linked || t('me.profile.providerFallback')
  const takeOffer = (password: string) =>
    action.run(async () => {
      const saved = await authApi.takeProviderEmail(password)
      setEmail(saved.email)
      if (saved.pending_email) throw new Done(t('account.emailConfirmSent', { email: saved.pending_email }))
    }, t('me.profile.emailTaken'))

  /** The hints under a field of the profile, each joined to it by aria-describedby (konten 0.3.7, `screenFields`). */
  const hintsOf = (field: 'displayName' | 'username' | 'email') =>
    (screenFields('profile').find((entry) => entry.field === field)?.hints ?? []).map((key) => t(key))

  const saveProfile = (password: string) =>
    action.run(async () => {
      const before = me.pending_email ?? me.email_pending ?? ''
      const saved = await authApi.profile({
        display_name: name,
        email: email.trim(),
        ...(username.trim().toLowerCase() !== me.name ? { name: username.trim() } : {}),
        ...(password ? { password } : {}),
      })
      setName(saved.display_name)
      setUsername(saved.name)
      setEmail(saved.email)
      rememberName(saved.name, saved.display_name)
      const waiting = saved.pending_email ?? saved.email_pending ?? ''
      if (waiting && waiting !== before) {
        // With a mail server the new address waits for its link; until then the old one counts.
        throw new Done(t('account.emailConfirmSent', { email: waiting }))
      }
    }, t('me.profileSaved'))

  const picture = pagePart('profile', 'picture')
  const pending = me.pending_email || me.email_pending || ''

  return (
    <Card id="profile" icon={UserRound} title={t(PAGES.profile.title)} testId="profile-card">
      <Said problem={action.problem} done={action.done} />
      <Box
        title={t(picture.title)}
        hint={t(picture.hint)}
        testId="profile-picture"
        actions={
          <>
            <AccountButton
              name="account.pictureUpload"
              accept="image/jpeg,image/png,image/webp,image/gif,image/bmp,image/heic,image/heif,image/avif,.heic,.heif"
              testId="picture"
              disabled={action.busy}
              onFile={(file) => void action.run(() => authApi.setAvatar(file), t('me.profile.saved'))}
            />
            {me.avatar && <AccountButton name="account.pictureRemove" disabled={action.busy} onClick={() => void action.run(() => authApi.removeAvatar(), t('me.profile.removed'))} />}
          </>
        }
      >
        <Avatar account={me} className="h-14 w-14 text-xl" />
      </Box>
      {/* One under the other, also on a wide screen (`layout: 'stacked'`). One button saves display name, username and
          email together, never leaving a field (konten 0.3.7, `PAGES.profile.save`); a new username or address asks
          for the password first (`confirmOnSave`). */}
      <form
        id="mail"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          const changed = { username: username.trim().toLowerCase() !== me.name, email: email.trim().toLowerCase() !== (me.email ?? '').toLowerCase() }
          const weighty = PAGES.profile.confirmOnSave.some((field) => changed[field])
          // An account with a password confirms a new username or address with it; one through a provider only is
          // asked for a fresh sign-in there by the server.
          if (weighty && me.sign_in === 'password') return setConfirming(true)
          void saveProfile('')
        }}
      >
        <Field label={t(pagePart('profile', 'displayName').title)} value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={DISPLAY_NAME_MAX} hints={hintsOf('displayName')} />
        <Field
          label={t(pagePart('profile', 'username').title)}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          maxLength={USERNAME_MAX}
          hints={me.former_name ? [...hintsOf('username'), t('account.formerUsername')] : hintsOf('username')}
        />
        <Field label={t(pagePart('profile', 'email').title)} value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" maxLength={EMAIL_MAX} hints={hintsOf('email')} />
        {pending && (
          <Box
            title={t('account.emailPending', { email: pending })}
            testId="email-pending"
            actions={
              <>
                <AccountButton name="account.emailResend" disabled={action.busy} onClick={() => void action.run(() => authApi.resendEmail(), t('account.emailConfirmSent', { email: pending }))} />
                <AccountButton name="account.emailWithdraw" disabled={action.busy} onClick={() => void action.run(() => authApi.withdrawEmail(), '')} />
              </>
            }
          />
        )}
        <div>
          <AccountButton
            name="account.save"
            type="submit"
            testId="profile-save"
            disabled={action.busy || (name.trim() === (me.display_name ?? '') && email.trim() === (me.email ?? '') && username.trim().toLowerCase() === me.name)}
          >
            {t(PAGES.profile.saveButton)}
          </AccountButton>
        </div>
      </form>
      {confirming && (
        <ConfirmDialog
          title={t('account.confirmWithPassword')}
          confirm={confirmOf('account.save', t('account.save'))}
          cancel={t('common.cancel')}
          closeLabel={t('common.close')}
          confirmDisabled={!own}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false)
            void saveProfile(own)
            setOwn('')
          }}
        >
          <Field label={t('account.currentPassword')} value={own} onChange={(event) => setOwn(event.target.value)} type="password" autoComplete="current-password" />
        </ConfirmDialog>
      )}
      {me.provider_email && (
        // The shared account module (0.3.3; the provider's name since 0.3.4): an account with a password is only
        // offered the address and takes it like a change of address, with its password; "No, thanks" holds for this
        // address for good.
        <Box
          title={t(pagePart('profile', 'providerEmailOffer').title, { provider: offerFrom })}
          hint={me.provider_email}
          testId="mail-offer"
          actions={
            <>
              <AccountButton name="account.providerEmailTake" disabled={action.busy} onClick={() => (me.sign_in === 'password' ? setTaking(true) : void takeOffer(''))} />
              <AccountButton name="account.providerEmailDismiss" disabled={action.busy} onClick={() => void action.run(() => authApi.declineProviderEmail(), t('me.profile.emailDeclined'))} />
            </>
          }
        />
      )}
      {taking && (
        <ConfirmDialog
          title={t('account.confirmWithPassword')}
          confirm={confirmOf('account.providerEmailTake', t('account.providerEmailTake'))}
          cancel={t('common.cancel')}
          closeLabel={t('common.close')}
          confirmDisabled={!own}
          onCancel={() => setTaking(false)}
          onConfirm={() => {
            setTaking(false)
            void takeOffer(own)
            setOwn('')
          }}
        >
          <Field label={t('account.currentPassword')} value={own} onChange={(event) => setOwn(event.target.value)} type="password" autoComplete="current-password" />
        </ConfirmDialog>
      )}
      {/* The language of the account, on every device (empty follows the browser); added languages say so. */}
      <SelectField
        label={t(pagePart('profile', 'language').title)}
        value={me.language}
        data-testid="language-select"
        options={[
          { value: '', label: t('me.languageBrowser') },
          ...languages.map((option) => ({ value: option.code, label: option.added ? `${option.name} (${t('settings.language.added')})` : option.name })),
        ]}
        onChange={(event) => {
          const code = event.target.value
          void action.run(() => setLanguage(code), '')
        }}
      />
      <p className="m-0 text-xs leading-4 text-[var(--nexui-text-muted)]" data-testid="profile-role">
        {t(pagePart('profile', 'role').title)}: {t(me.role === 'operator' ? 'account.roleOperator' : 'account.roleMember')}
      </p>
    </Card>
  )
}

/** "Sign out" of this browser, in the profile, where the account menu had it before; other devices stay signed in. */
export function SignOutCard() {
  const { t } = useTranslation()
  const { signOut } = useAuth()
  const navigate = useNavigate()
  return (
    <Card id="sign-out" icon={LogOut} title={t('me.signOut')} subtitle={t('me.signOutText')} testId="sign-out-card">
      <div>
        <AccountButton name="signOut" testId="sign-out" onClick={() => void signOut().then(() => navigate('/login', { replace: true }))}>
          {t('me.signOut')}
        </AccountButton>
      </div>
    </Card>
  )
}

/** The module's security page: the password with its last change, the second factor and its recovery codes, passkeys,
 * the signed-in devices with "Sign out everywhere else", the mail at a new sign-in; then nexlore's own part, the sign-in
 * providers of the account (link, unlink; the last link of an account without a password stays). */
export function SecurityCard({ me }: { me: Me }) {
  const { t, i18n } = useTranslation()
  const [params] = useSearchParams()
  const action = useCardAction()
  const [providers, setProviders] = useState<MyProvider[] | null>(null)
  const loadProviders = () => authApi.myProviders().then(setProviders, () => setProviders([]))
  useEffect(() => {
    void loadProviders()
  }, [])
  const [changing, setChanging] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const again = usePasswordConfirm(next)
  const [linkPassword, setLinkPassword] = useState('')
  const [linking, setLinking] = useState<MyProvider | null>(null)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const linkedSlug = params.get('linked')
  const [linkedShown, setLinkedShown] = useState(!!linkedSlug)
  const linkedLabel = providers?.find((entry) => entry.slug === linkedSlug)?.label
  // Back from the provider with a refusal: only a known sign-in code becomes a sentence.
  const addressError = params.get('error')
  const [addressProblem] = useState<string | null>(addressError ? (oidcErrorKey(addressError) ? t(oidcErrorKey(addressError)!) : errorText(addressError)) : null)

  /** "Last changed on …" in the box Password, or that it is not known (konten 0.3.10, `passwordChanged`). */
  const changed = passwordChanged(me.password_changed_at)
  const changedLine = t(changed.text, changed.date ? { day: day(changed.date, i18n.language) } : undefined)

  const closePassword = () => {
    setChanging(false)
    setCurrent('')
    setNext('')
    again.clear()
    setDialogProblem(null)
  }
  const lastLinkOf = (provider: MyProvider) => me.sign_in === 'oidc' && provider.linked && (providers ?? []).filter((entry) => entry.linked).length === 1
  const done = action.done ?? (linkedShown && linkedLabel ? t('me.linked', { name: linkedLabel }) : null)

  return (
    <Card id="security" icon={ShieldCheck} title={t(PAGES.security.title)} testId="security-card">
      <Said problem={action.problem ?? addressProblem} done={done} />
      {me.second_factor_setup_required && <Notice tone="warn">{t('twofactor.requiredText')}</Notice>}

      {me.sign_in === 'password' && (
        <Box
          title={t(pagePart('security', 'password').title)}
          hint={changedLine}
          testId="password-row"
          actions={
            <AccountButton
              name="account.passwordChange"
              testId="password-change"
              onClick={() => {
                action.setDone(null)
                setLinkedShown(false)
                setChanging(true)
              }}
            />
          }
        />
      )}
      {changing && (
        <ConfirmDialog
          title={t('account.passwordChange')}
          confirm={confirmOf('resetSubmit', t('me.password.submit'))}
          cancel={t('common.cancel')}
          closeLabel={t('common.close')}
          busy={action.busy}
          error={dialogProblem}
          onCancel={closePassword}
          onConfirm={() => {
            if (!current) return setDialogProblem(errorText('current_password_missing'))
            if (!next) return setDialogProblem(errorText('password_missing'))
            setDialogProblem(null)
            if (!again.matches()) return
            void action.run(() => authApi.changePassword(current, next, again.confirm), t('me.password.done')).then((ok) => {
              if (ok) closePassword()
            })
          }}
        >
          {/* The account module's words for every password field (plan E33). */}
          <Field label={t(FIELDS.currentPassword.label)} value={current} onChange={(event) => setCurrent(event.target.value)} type="password" autoComplete={FIELDS.currentPassword.autoComplete} />
          <Field label={t(fieldLabel('change', 'newPassword'))} value={next} onChange={(event) => setNext(event.target.value)} type="password" autoComplete={FIELDS.newPassword.autoComplete} hints={[t(FIELDS.newPassword.hint, { minimum: me.min_password ?? 12 })]} />
          <Field
            label={t(FIELDS.passwordRepeat.label)}
            name="password_confirm"
            value={again.confirm}
            onChange={(event) => again.setConfirm(event.target.value)}
            type="password"
            autoComplete="new-password"
            error={again.mismatch ? t('account.passwordMismatch') : undefined}
          />
        </ConfirmDialog>
      )}

      <SecondFactor me={me} />

      <PasskeysBox signedInByPassword={me.sign_in === 'password'} canAdd={me.passkeys_can_add !== false} operator={me.role === 'operator'} />

      <SessionsBox busy={action.busy} onEverywhere={() => action.run(() => authApi.logoutEverywhere(), t('me.sessions.done'))} />

      <CheckboxRow
        label={t(pagePart('security', 'newSignInMail').title)}
        hint={t(pagePart('security', 'newSignInMail').hint)}
        checked={me.new_sign_in_mail !== false}
        disabled={action.busy}
        onChange={(on) => void action.run(() => authApi.newSignInMail(on), '')}
      />

      {/* nexlore's own part comes after the module's (`pageOrder`): the providers, a box in this card. */}
      {providers !== null && (providers.length > 0 || me.sign_in === 'oidc') && (
        <Box title={t('oidc.account.title')} hint={t('oidc.account.text')} testId="my-providers">
          <Rows label={t('oidc.account.title')}>
            {providers.map((provider) => {
              // The last link of an account without a password stays: it would lock the account out.
              const lastLink = lastLinkOf(provider)
              return (
                <Row
                  key={provider.slug}
                  icon={KeyRound}
                  name={provider.label}
                  badge={<Badge tone={provider.linked ? 'on' : 'off'}>{provider.linked ? t('oidc.account.linked') : t('oidc.account.notLinked')}</Badge>}
                  note={lastLink ? t('oidc.account.only', { name: provider.label }) : undefined}
                  action={
                    provider.linked ? (
                      !lastLink && (
                        <AccountButton
                          name="oidc.account.unlink"
                          disabled={action.busy}
                          onClick={() =>
                            void action.run(async () => {
                              await authApi.unlink(provider.slug)
                              await loadProviders()
                            }, t('me.unlinked', { name: provider.label }))
                          }
                        />
                      )
                    ) : (
                      me.sign_in === 'password' && (
                        <AccountButton
                          name="oidc.account.link"
                          disabled={action.busy}
                          onClick={() => {
                            setLinkPassword('')
                            setDialogProblem(null)
                            setLinking(provider)
                          }}
                        />
                      )
                    )
                  }
                />
              )
            })}
          </Rows>
        </Box>
      )}
      {linking && (
        <ConfirmDialog
          title={`${t('oidc.account.link')}: ${linking.label}`}
          text={t('oidc.account.text')}
          confirm={confirmOf('oidc.account.link', t('oidc.account.link'))}
          cancel={t('common.cancel')}
          closeLabel={t('common.close')}
          busy={action.busy}
          error={dialogProblem}
          confirmDisabled={!linkPassword}
          onCancel={() => setLinking(null)}
          onConfirm={() => {
            action.setBusy(true)
            setDialogProblem(null)
            authApi.linkStart(linking.slug, linkPassword).then(
              ({ url }) => window.location.assign(url),
              (error) => {
                setDialogProblem(problemText(error))
                action.setBusy(false)
              },
            )
          }}
        >
          <Field label={t('account.password')} value={linkPassword} onChange={(event) => setLinkPassword(event.target.value)} type="password" autoComplete="current-password" />
        </ConfirmDialog>
      )}
    </Card>
  )
}

/** At the top of every area of the own account: the emergency hammer, and after a password set through a link what
 * still has access. */
export function AccountNotices({ me }: { me: Me }) {
  const { refresh } = useAuth()
  return (
    <>
      <SecondFactorOffNotice on={me.second_factor_off} />
      {(me.new_password_origin || me.password_reset_notice) && (
        <RemainingAccess
          onDone={() => {
            // The operator's link is told once ("The operator made you a link"), put away with the list.
            const seen = me.password_reset_notice ? authApi.resetNoticeSeen().catch(() => undefined) : Promise.resolve()
            void seen.then(() => refresh())
          }}
        />
      )}
    </>
  )
}
