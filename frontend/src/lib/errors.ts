/** The sentence for an error code from the server, in the page's language; an unknown code gets the general one. */
import i18n from '../i18n'
import { oidcErrorKey } from '../vendor/nexoidc/oidc'

/** Why the last name was refused (`reason`, `char`, `word`): pages keep only the code, the sentence still says
 * which character or rule (P1.24). */
let lastRefusal: Record<string, unknown> = {}

export function nameRefused(values: Record<string, unknown>): void {
  lastRefusal = values
}

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
  const key = `errors.byCode.${code}`
  if (i18n.exists(key)) return i18n.t(key, values)
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
