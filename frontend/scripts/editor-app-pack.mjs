/**
 * Builds nexlore's editor alone for the iPhone app (vite.editor.config.ts) into dist-editor/ and writes
 * dist-editor/manifest.json beside it: nexlore's version and the sha256 of every file. The app copies the folder into
 * its bundle when it is built (nexlore-ios, docs/editor-bruecke.md) and can check it against the manifest.
 *
 * It refuses a build the app could not open from a file:// URL: a module script, or an address starting at the root.
 *
 *   node scripts/editor-app-pack.mjs
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const frontend = path.resolve(here, '..')
const out = path.join(frontend, 'dist-editor')

const vite = path.join(frontend, 'node_modules', 'vite', 'bin', 'vite.js')
const built = spawnSync(process.execPath, [vite, 'build', '--config', 'vite.editor.config.ts'], { cwd: frontend, stdio: 'inherit' })
if (built.status !== 0) process.exit(built.status ?? 1)

const version = /__version__\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(frontend, '..', 'backend', 'app', '__init__.py'), 'utf8'))[1]

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}

const html = fs.readFileSync(path.join(out, 'editor-app.html'), 'utf8')
const problems = []
if (/type="module"/.test(html)) problems.push('editor-app.html loads a module script')
if (/\s(?:src|href)="\/(?!\/)/.test(html)) problems.push('editor-app.html has an address starting at the root')
for (const file of walk(out).filter((name) => name.endsWith('.css'))) {
  if (/url\(\s*["']?\/(?!\/)/.test(fs.readFileSync(file, 'utf8'))) problems.push(`${path.relative(out, file)} has an address starting at the root`)
}
if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}

const files = {}
let bytes = 0
for (const file of walk(out).sort()) {
  const name = path.relative(out, file).split(path.sep).join('/')
  if (name === 'manifest.json') continue
  const data = fs.readFileSync(file)
  bytes += data.length
  files[name] = createHash('sha256').update(data).digest('hex')
}
const manifest = { name: 'nexlore-editor', version, entry: 'editor-app.html', files }
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`dist-editor: nexlore ${version}, ${Object.keys(files).length} files, ${(bytes / 1024 / 1024).toFixed(2)} MB`)
