// Two stand-ins for the end-to-end tests of the mail address (email.spec.ts), never anything real:
// - a mail server (plain SMTP, no TLS, no login) that keeps every mail; GET /mails lists them, DELETE /mails empties;
// - a sign-in provider under /oidc that a browser really goes through: /oidc/auth answers at once with a code for
//   whoever POST /oidc/next named (sub, email, email_verified, preferred_username), the token is signed with a key
//   made here at the start.
import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'

const PORT = Number(process.env.FAKE_POSTBOX_PORT ?? 8476)
const SMTP_PORT = Number(process.env.FAKE_SMTP_PORT ?? 2525)
const ISSUER = `http://127.0.0.1:${PORT}/oidc`
const KID = 'e2e-key'

const mails = []
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
let next = { sub: 'person-1', email: 'person@example.com', email_verified: true, preferred_username: 'person' }
const codes = new Map()

// --- The mail server --------------------------------------------------------------------------------------------------

function unfold(raw) {
  const [head, ...rest] = raw.split(/\r?\n\r?\n/)
  const headers = {}
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at > 0) headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim()
  }
  let body = rest.join('\n\n').replace(/\r\n/g, '\n').replace(/^\.\./gm, '.')
  if (/quoted-printable/i.test(headers['content-transfer-encoding'] ?? '')) {
    body = body.replace(/=\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  } else if (/base64/i.test(headers['content-transfer-encoding'] ?? '')) {
    body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf-8')
  }
  return { to: headers.to ?? '', subject: headers.subject ?? '', body }
}

net
  .createServer((socket) => {
    socket.setEncoding('utf-8')
    let buffer = ''
    let data = null
    const say = (line) => socket.write(line + '\r\n')
    say('220 postbox.example.com ESMTP stand-in')
    socket.on('data', (chunk) => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (data !== null) {
          if (line === '.') {
            mails.push(unfold(data.join('\r\n')))
            data = null
            say('250 kept')
          } else data.push(line)
          continue
        }
        const verb = line.slice(0, 4).toUpperCase()
        if (verb === 'EHLO') {
          say('250-postbox.example.com')
          say('250 SMTPUTF8')
        } else if (verb === 'HELO' || verb === 'MAIL' || verb === 'RCPT' || verb === 'RSET' || verb === 'NOOP') say('250 ok')
        else if (verb === 'DATA') {
          data = []
          say('354 go on')
        } else if (verb === 'QUIT') {
          say('221 bye')
          socket.end()
        } else say('502 not here')
      }
    })
    socket.on('error', () => {})
  })
  .listen(SMTP_PORT, '127.0.0.1')

// --- The sign-in provider ---------------------------------------------------------------------------------------------

const b64url = (value) => Buffer.from(value).toString('base64url')

function idToken(claims) {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }))
  const body = b64url(JSON.stringify(claims))
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')
  return `${head}.${body}.${signature}`
}

http
  .createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      const url = new URL(request.url, `http://127.0.0.1:${PORT}`)
      const send = (status, value) => {
        response.writeHead(status, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(value))
      }
      if (url.pathname === '/health') return send(200, { ok: true })
      if (url.pathname === '/mails' && request.method === 'GET') return send(200, mails)
      if (url.pathname === '/mails' && request.method === 'DELETE') {
        mails.length = 0
        return send(200, { ok: true })
      }
      if (url.pathname === '/oidc/next' && request.method === 'POST') {
        next = { email_verified: true, ...JSON.parse(raw || '{}') }
        return send(200, next)
      }
      if (url.pathname === '/oidc/.well-known/openid-configuration') {
        return send(200, {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/auth`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
          userinfo_endpoint: `${ISSUER}/userinfo`,
        })
      }
      if (url.pathname === '/oidc/jwks') {
        return send(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' }] })
      }
      if (url.pathname === '/oidc/auth') {
        // Whoever was named last signs in, at once: the browser goes straight back to nexlore with a code.
        const code = crypto.randomBytes(12).toString('hex')
        codes.set(code, {
          claims: next,
          nonce: url.searchParams.get('nonce'),
          challenge: url.searchParams.get('code_challenge'),
          client: url.searchParams.get('client_id'),
        })
        const back = new URL(url.searchParams.get('redirect_uri'))
        back.searchParams.set('code', code)
        back.searchParams.set('state', url.searchParams.get('state') ?? '')
        response.writeHead(302, { Location: back.toString() })
        return response.end()
      }
      if (url.pathname === '/oidc/token' && request.method === 'POST') {
        const form = new URLSearchParams(raw)
        const kept = codes.get(form.get('code') ?? '')
        codes.delete(form.get('code') ?? '')
        const verifier = form.get('code_verifier') ?? ''
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
        if (!kept || challenge !== kept.challenge) return send(400, { error: 'invalid_grant' })
        const now = Math.floor(Date.now() / 1000)
        const claims = { iss: ISSUER, aud: kept.client, exp: now + 300, iat: now, nonce: kept.nonce, ...kept.claims }
        return send(200, { id_token: idToken(claims), access_token: `access-${kept.claims.sub}`, token_type: 'Bearer' })
      }
      if (url.pathname === '/oidc/userinfo') {
        // The id token says it all; userinfo adds nothing (as authentik does with the default scopes).
        return send(404, { error: 'not here' })
      }
      send(404, { error: 'not found' })
    })
  })
  .listen(PORT, '127.0.0.1')
