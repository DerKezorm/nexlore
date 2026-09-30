/** The sentence for an error code from the server, in the page's language; an unknown code gets the general one. */
import i18n from '../i18n'

export function errorText(code: string, values: Record<string, unknown> = {}): string {
  // Waiting after too many tries: say how long, in minutes (the server sends seconds).
  if (code === 'too_many_attempts' && typeof values.retry_after === 'number' && values.retry_after > 0) {
    return i18n.t('errors.waitMinutes', { count: Math.ceil(values.retry_after / 60) })
  }
  const key = `errors.byCode.${code}`
  return i18n.exists(key) ? i18n.t(key, values) : i18n.t('errors.byCode.internal_error')
}

/** What a service outside (the AI service) answered with its error, to stand after the sentence: " (400: …)". */
export function serviceSaid(error: unknown): string {
  const values = (error as { values?: Record<string, unknown> } | null)?.values
  const answered = values?.answered
  if (typeof answered !== 'number') return ''
  const said = typeof values?.said === 'string' ? values.said : ''
  return said ? ` (${answered}: ${said})` : ` (${answered})`
}
