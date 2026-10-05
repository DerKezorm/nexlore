// A stand-in AI service for the end-to-end tests: the usual chat interface, answering by rule, never a real model
// and never a real key. GET /last gives the last request it got, so a test can see what went out.
import http from 'node:http'

const PORT = Number(process.env.FAKE_AI_PORT ?? 8478)
let last = null
// The newest release the update check is told about; about.spec.ts sets it with POST /releases/latest.
let release = 'v9.0.0'
let hooked = null

/** Lore (lore.spec.ts): an answer with a source and a line for what the notes do not say; a note changed on request. */
function lore(body) {
  const system = body.messages?.[0]?.content ?? ''
  if (system.startsWith('You are Lore')) return 'The glasswing backups run every hour [1].\n\n!missing: when the copy was last checked'
  if (system.startsWith('You change a note')) {
    const asked = body.messages?.[1]?.content ?? ''
    const note = asked.slice(asked.indexOf('The note:\n\n') + 11, asked.indexOf('\n\nThe question about it:'))
    return note.replace(/\n*$/, '\n') + '\n- [ ] Check the copy\n'
  }
  return null
}

function answer(body) {
  const system = body.messages?.[0]?.content ?? ''
  const text = body.messages?.[1]?.content ?? ''
  const task = system.slice(system.lastIndexOf('Task:'))
  if (task.startsWith('Task: Correct spelling')) return text.replace(/\bteh\b/g, 'the')
  if (task.startsWith('Task: Rewrite')) return text.replace(/\bWe meet\b/, 'We will gather')
  if (task.startsWith('Task: Translate')) return text.replace(/\bSecond line stays\b/, 'Zweite Zeile bleibt')
  if (task.startsWith('Task: Summarize')) return '- Summary: a meeting on Thursday.'
  if (task.startsWith('Task: Write')) return '```markdown\n## Agenda\n\n- [ ] Welcome\n- [ ] Office\n```'
  return text
}

http
  .createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      const send = (status, value) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(value))
      }
      if (request.url === '/health') return send(200, { ok: true })
      if (request.url === '/last') return send(200, last)
      // A webhook for notifications (notify.spec.ts): what came last, and what the test asks for.
      if (request.url === '/hook' && request.method === 'POST') {
        hooked = JSON.parse(raw)
        return send(200, { ok: true })
      }
      if (request.url === '/hook/last') return send(200, hooked)
      // The update check (about.spec.ts) asks here instead of GitHub.
      if (request.url === '/releases/latest' && request.method === 'POST') {
        release = JSON.parse(raw).tag_name
        return send(200, { tag_name: release })
      }
      if (request.url === '/releases/latest') return send(200, { tag_name: release })
      if (request.headers.authorization !== 'Bearer e2e-stand-in-key') return send(401, { error: 'key' })
      // Vectors for finding by meaning (lore.spec.ts): by the words a text has, so that notes sharing words are near.
      if (request.method === 'POST' && request.url === '/v1/embeddings') {
        const texts = JSON.parse(raw).input
        const vector = (text) => {
          const numbers = new Array(32).fill(0)
          for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter((item) => item.length > 3)) {
            let hash = 0
            for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % 32
            numbers[hash] += 1
          }
          return numbers
        }
        return send(200, { data: texts.map((text, index) => ({ index, embedding: vector(text) })) })
      }
      if (request.method === 'GET' && request.url === '/v1/models') return send(200, { data: [{ id: 'stand-in', display_name: 'Stand-in' }] })
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        const body = JSON.parse(raw)
        last = body
        // A request the service turns down, with its own words about why.
        if (String(body.messages?.[0]?.content ?? '').includes('Turn this down')) {
          return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'temperature: not allowed here' } })
        }
        // Lore with tools (lore.spec.ts): asked to look further, the stand-in asks for a search first.
        const question = body.messages?.findLast?.((message) => message.role === 'user')?.content ?? ''
        if (body.stream && body.tools && /look further/i.test(question) && !body.messages.some((message) => message.role === 'tool')) {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          const call = { index: 0, id: 'call-e2e', type: 'function', function: { name: 'search_notes', arguments: JSON.stringify({ words: 'glasswing restore' }) } }
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] })}\n\n`)
          response.end('data: [DONE]\n\n')
          return
        }
        const spoken = lore(body)
        // A flowing answer, as the services send it when asked to (`stream`): a line per piece, then the end.
        if (spoken !== null && body.stream) {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          for (let at = 0; at < spoken.length; at += 6) {
            response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: spoken.slice(at, at + 6) } }] })}\n\n`)
          }
          response.end('data: [DONE]\n\n')
          return
        }
        return send(200, { choices: [{ message: { content: spoken ?? answer(body) } }], usage: { prompt_tokens: 12, completion_tokens: 5 } })
      }
      send(404, { error: 'not found' })
    })
  })
  .listen(PORT, '127.0.0.1')
