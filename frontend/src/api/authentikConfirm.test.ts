/** The authentik button's call carries the answer to the question "another issuer, accounts link again" (module 1.0.8). */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { adminApi } from './client'

afterEach(() => vi.unstubAllGlobals())

async function bodyOf(call: () => Promise<unknown>): Promise<unknown> {
  const sent: unknown[] = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify({ steps: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  await call()
  return sent[0]
}

describe('the authentik call', () => {
  it('says no to the question unless the operator said yes, and says yes when he did', async () => {
    expect(await bodyOf(() => adminApi.authentik('https://auth.example.com', 'token'))).toEqual({
      url: 'https://auth.example.com',
      token: 'token',
      confirm_issuer_change: false,
    })
    expect(await bodyOf(() => adminApi.authentik('https://auth.example.com', 'token', true))).toEqual({
      url: 'https://auth.example.com',
      token: 'token',
      confirm_issuer_change: true,
    })
  })
})

describe('the authentik card and the public address (module 1.0.10)', () => {
  it('sends the address the operator confirmed only when there is one', async () => {
    expect(await bodyOf(() => adminApi.authentik('https://auth.example.com', 'token', false, 'https://notes.example.com'))).toEqual({
      url: 'https://auth.example.com',
      token: 'token',
      confirm_issuer_change: false,
      public_url: 'https://notes.example.com',
    })
  })

  it('"Use it only" sends the address and the answer to the question', async () => {
    expect(await bodyOf(() => adminApi.saveAuthentikAddress('https://notes.example.com'))).toEqual({
      public_url: 'https://notes.example.com',
      confirm: false,
    })
    expect(await bodyOf(() => adminApi.saveAuthentikAddress('https://notes.example.com', true))).toEqual({
      public_url: 'https://notes.example.com',
      confirm: true,
    })
  })

  it('saves the address on the settings page with the answer to the question when it was asked', async () => {
    expect(await bodyOf(() => adminApi.saveSettings({ public_url: 'https://notes.example.com' }))).toEqual({
      public_url: 'https://notes.example.com',
    })
    expect(await bodyOf(() => adminApi.saveSettings({ public_url: 'https://notes.example.com', confirm_address: true }))).toEqual({
      public_url: 'https://notes.example.com',
      confirm_address: true,
    })
  })
})
