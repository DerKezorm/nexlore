/**
 * The browser's side of passkeys (WebAuthn): the server's options (JSON, binary fields as base64url, as the shared
 * account module sends them) into what `navigator.credentials` takes, and the browser's answer back into JSON.
 */
import { passkeysApi, type Me } from '../api/client'

function toBytes(text: string): ArrayBuffer {
  const base = text.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base + '='.repeat((4 - (base.length % 4)) % 4)
  const raw = atob(padded)
  const bytes = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index)
  return bytes.buffer
}

function toText(buffer: ArrayBuffer | null | undefined): string {
  if (!buffer) return ''
  let raw = ''
  for (const byte of new Uint8Array(buffer)) raw += String.fromCharCode(byte)
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

type Described = { id: string; type?: string; transports?: string[] }

/** Whether this browser can use passkeys at all. */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && 'PublicKeyCredential' in window && !!navigator.credentials
}

function credentialJson(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AuthenticatorAttestationResponse & AuthenticatorAssertionResponse
  const body: Record<string, unknown> = {
    clientDataJSON: toText(response.clientDataJSON),
  }
  if ('attestationObject' in response && response.attestationObject) {
    body.attestationObject = toText(response.attestationObject)
    body.transports = typeof response.getTransports === 'function' ? response.getTransports() : []
  }
  if ('authenticatorData' in response && response.authenticatorData) {
    body.authenticatorData = toText(response.authenticatorData)
    body.signature = toText(response.signature)
    body.userHandle = toText(response.userHandle)
  }
  return {
    id: credential.id,
    rawId: toText(credential.rawId),
    type: credential.type,
    response: body,
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
    authenticatorAttachment: credential.authenticatorAttachment ?? null,
  }
}

/** Adds a passkey to the own account: the password (or a fresh provider sign-in) first, then the browser asks. */
export async function addPasskey(password: string, name: string): Promise<void> {
  const { token, options } = await passkeysApi.beginAdd(password)
  const raw = options as Record<string, unknown> & { challenge: string; user: { id: string }; excludeCredentials?: Described[] }
  const publicKey = {
    ...raw,
    challenge: toBytes(raw.challenge),
    user: { ...raw.user, id: toBytes(raw.user.id) },
    excludeCredentials: (raw.excludeCredentials ?? []).map((entry) => ({ ...entry, id: toBytes(entry.id) })),
  } as unknown as PublicKeyCredentialCreationOptions
  const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null
  if (!credential) throw new Error('passkey_cancelled')
  await passkeysApi.finishAdd(token, credentialJson(credential), name)
}

/** Signs in with a passkey (also in place of the code after the password). */
export async function signInWithPasskey(): Promise<Me> {
  const { token, options } = await passkeysApi.beginSignIn()
  const raw = options as Record<string, unknown> & { challenge: string; allowCredentials?: Described[] }
  const publicKey = {
    ...raw,
    challenge: toBytes(raw.challenge),
    allowCredentials: (raw.allowCredentials ?? []).map((entry) => ({ ...entry, id: toBytes(entry.id) })),
  } as unknown as PublicKeyCredentialRequestOptions
  const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null
  if (!credential) throw new Error('passkey_cancelled')
  return passkeysApi.finishSignIn(token, credentialJson(credential))
}
