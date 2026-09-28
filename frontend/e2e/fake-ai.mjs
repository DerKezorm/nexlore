// A stand-in AI service for the end-to-end tests: the usual chat interface, answering by rule, never a real model
// and never a real key. GET /last gives the last request it got, so a test can see what went out.
import http from 'node:http'

const PORT = Number(process.env.FAKE_AI_PORT ?? 8478)
let last = null

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
      if (request.headers.authorization !== 'Bearer e2e-stand-in-key') return send(401, { error: 'key' })
      if (request.method === 'GET' && request.url === '/v1/models') return send(200, { data: [{ id: 'stand-in', display_name: 'Stand-in' }] })
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        const body = JSON.parse(raw)
        last = body
        return send(200, { choices: [{ message: { content: answer(body) } }], usage: { prompt_tokens: 12, completion_tokens: 5 } })
      }
      send(404, { error: 'not found' })
    })
  })
  .listen(PORT, '127.0.0.1')
