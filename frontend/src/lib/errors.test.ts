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
    expect(errorText('provider_first')).toBe('Set up a sign-in provider first, or nobody but you could sign in.')
    expect(errorText('made_up_code')).not.toContain('made_up_code')
  })
})
