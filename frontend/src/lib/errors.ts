/** The sentence for an error code from the server, in the page's language; an unknown code gets the general one. */
import i18n from '../i18n'
import { KI_TEXTS, refusalText } from '../vendor/nexki/ki'
import { accountErrorKeyOf } from '../vendor/nexkonten/konten'
import { mailErrorKey } from '../vendor/nexpost/post'
import { oidcErrorKey } from '../vendor/nexoidc/oidc'

/** The codes nexlore answered with before the shared account module, and the module's names for them (the server's
 * `konten_store.OLD_CODES` the other way round; 1.16.0's pages and scripts keep the old ones). */
export const OLD_ACCOUNT_CODES: Readonly<Record<string, string>> = {
  invalid_email: 'email_invalid',
  name_taken: 'username_taken',
  invalid_name: 'username_invalid',
  totp_code_wrong: 'code_wrong',
  second_factor_expired: 'sign_in_expired',
}

/** Why the last name was refused (`reason`, `char`, `word`): pages keep only the code, the sentence still says
 * which character or rule (P1.24). */
let lastRefusal: Record<string, unknown> = {}

export function nameRefused(values: Record<string, unknown>): void {
  lastRefusal = values
}

/** Codes of the account module that nexlore's other routes answer with too, in their own sense. */
const GENERAL_CODES = new Set(['not_found', 'not_allowed', 'too_many_attempts'])

export function errorText(code: string, values: Record<string, unknown> = {}): string {
  if (code === 'name_invalid') {
    const why = { ...lastRefusal, ...values }
    const key = `errors.byCode.name_invalid_${String(why.reason)}`
    if (typeof why.reason === 'string' && i18n.exists(key)) return i18n.t(key, why)
  }
  // Waiting after too many tries: say how long, in minutes (the server sends seconds).
  if (code === 'too_many_attempts' && typeof values.retry_after === 'number' && values.retry_after > 0) {
    return i18n.t('errors.waitMinutes', { count: Math.ceil(values.retry_after / 60) })
  }
  // Every wrong sign-in says the same, whatever was wrong (the shared account module, `account.wrong`).
  if (code === 'wrong_credentials') return i18n.t('account.wrong')
  // The codes of the shared account and post modules bring their sentences with the modules (`account.error.*`,
  // `mail.error.*`), the same in every nex app; the module's own code first where the server names it next to an old
  // one (`account_code`, konten 0.3.10).
  const accountCode = typeof values.account_code === 'string' ? values.account_code : null
  // Codes every route of nexlore uses ("not found" of a note) say the account module's words only where the server
  // names the module's code (an account that is not there is not a note that is not there).
  const general = GENERAL_CODES.has(code) && !accountCode
  const account = general ? 'account.error.unknown' : accountErrorKeyOf({ code, account_code: accountCode }, OLD_ACCOUNT_CODES)
  if (account !== 'account.error.unknown' && i18n.exists(account)) return i18n.t(account, values)
  const mail = mailErrorKey(code)
  if (mail !== 'mail.error.unknown' && i18n.exists(mail)) return i18n.t(mail, values)
  const key = `errors.byCode.${code}`
  if (i18n.exists(key)) return i18n.t(key, values)
  // The codes of the shared AI module that nexlore's routes of before pass on as they are (ai_https_required,
  // ai_used_up, ai_day_used …) bring their sentences with the module (ki 0.1.0).
  const kiTexts = KI_TEXTS[(i18n.language || 'en').slice(0, 2) as 'de' | 'en' | 'fr'] ?? KI_TEXTS.en
  if (code.startsWith('ai_') && code in kiTexts.errors) return refusalText(kiTexts, { code, ...values }, 'nexlore')
  // The fixed codes of sign-in through a provider bring their sentences with the shared module (`oidc.error.*`).
  const signIn = oidcErrorKey(code)
  return signIn ? i18n.t(signIn) : i18n.t('errors.byCode.internal_error')
}

/** What a service outside (the AI service) answered with its error, to stand after the sentence: " (400: …)". */
export function serviceSaid(error: unknown): string {
  const values = (error as { values?: Record<string, unknown> } | null)?.values
  const answered = values?.answered
  if (typeof answered !== 'number') return ''
  const said = typeof values?.said === 'string' ? values.said : ''
  return said ? ` (${answered}: ${said})` : ` (${answered})`
}

/** The sentence for whatever went wrong, with the values the server sent along ("at least {{minimum}} characters"). */
export function problemText(error: unknown): string {
  const found = error as { code?: unknown; values?: Record<string, unknown> } | null
  return found && typeof found.code === 'string' && found.values ? errorText(found.code, found.values) : errorText('internal_error')
}
