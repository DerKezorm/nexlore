/** The sentence for a server code: nexlore's own first, then the fixed codes of sign-in through a provider. */
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { startI18n } from '../i18n'
import { errorText } from './errors'

beforeAll(async () => {
  vi.stubGlobal('fetch', async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
  await startI18n()
})

describe('error sentences', () => {
  it('say the fixed sign-in codes in the words of the shared module', () => {
    expect(errorText('oidc_only_account')).toBe('This account signs in through this provider only. The last link stays.')
    expect(errorText('oidc_subject_taken')).toBe('This identity is linked to another account already.')
  })

  it('keep nexlore\'s own sentence where it has one, and never show an unknown code', () => {
    expect(errorText('ai_off')).toBe('AI in notes is off on this server.')
    // A code the shared account module names since 1.1.0 says the module's words, the same in every app.
    expect(errorText('provider_first')).toBe('Without an active sign-in provider, signing in with a password stays on.')
    expect(errorText('made_up_code')).not.toContain('made_up_code')
  })
})
