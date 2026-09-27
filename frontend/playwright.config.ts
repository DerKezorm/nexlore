/**
 * End-to-end, headless. The built frontend is served by the real backend, as in the container, so the Content
 * Security Policy applies. Own data directory and own port, so a running development server is never measured.
 *
 *   npm run e2e                      build, start the backend on 8471, test
 *   E2E_BASE_URL=http://host:8470 npx playwright test    against a running instance (the server's own languages)
 */
import { defineConfig } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT = 8471
const external = process.env.E2E_BASE_URL

/**
 * A fresh data directory per run, with one operator language that is deliberately incomplete and one broken file.
 * Made here and not in a global setup: the server starts first, and under Windows its open log file would block
 * cleaning up a fixed directory. The workers load this file again and inherit the directory through the environment.
 */
function dataDir(): string {
  if (process.env.NEXLORE_E2E_DATA) return process.env.NEXLORE_E2E_DATA
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexlore-e2e-'))
  const locales = path.join(dir, 'locales')
  fs.mkdirSync(locales)
  const spanish = { _meta: { name: 'Español' }, nav: { graph: 'Grafo', notes: 'Notas', files: 'Archivos', settings: 'Ajustes' } }
  fs.writeFileSync(path.join(locales, 'es.json'), JSON.stringify(spanish))
  fs.writeFileSync(path.join(locales, 'xx.json'), '{broken')
  for (const [name, content] of Object.entries(E2E_NOTES)) {
    const file = path.join(dir, 'vault', ...name.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  process.env.NEXLORE_E2E_DATA = dir
  return dir
}

/** Small pictures and a PDF for the attachment tests (attachments.spec.ts), made once with Pillow. */
const ORANGE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAIAAABChommAAAAFUlEQVR42mN8ViHCQAgwMRABhrciALQ1AYLyZG5iAAAAAElFTkSuQmCC', 'base64')
const BLUE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAIAAABChommAAAAFUlEQVR42mMUqXjGQAgwMRABhrciALKRAYJ+ADfJAAAAAElFTkSuQmCC', 'base64')
const LEAFLET_PDF = Buffer.from(
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMjAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0OSA+PgpzdHJlYW0KQlQgL0YxIDEyIFRmIDIwIDEwMCBUZCAoa2luZ2Zpc2hlciBsYW50ZXJuKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDM0MCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQxMAolJUVPRgo=',
  'base64',
)

/** An invented vault for the tests; each test works on its own notes, so the order does not matter. */
const E2E_NOTES: Record<string, string | Buffer> = {
  'Work/Plan.md': '---\ntags: [project]\n---\n# Plan\n\nThe roadmap links to [[Garden]] and to [[Missing note]].\n',
  'Work/Ideas/Garden.md': '# Garden\n\nTomatoes and basil grow here. Back to [[Plan]].\n',
  'Work/Scratch.md': '# Scratch\n\nFirst line.\n',
  'Work/Conflict.md': '# Conflict\n\nBefore.\n',
  'Work/Locked.md': '# Locked\n\nSomebody types here.\n',
  'Work/Rename me.md': '# Rename me\n',
  'Work/Points at rename.md': 'See [[Rename me]] and [it](Rename%20me.md).\n',
  'Work/Delete me.md': '# Delete me\n\nGone soon.\n',
  'Home/Shopping.md': '# Shopping\n\nMilk, flour and quinceapple jam.\n',
  // "#" and "%" are legal in names on every system and mean something in an address.
  'Home/50% C# done.md': '# Odd name\n\nThe zebracorn lives here.\n',
  'Switch/From.md': '# From\n\nStart.\n',
  'Switch/To.md': '# To\n\nOther note.\n',
  // The editor (editor.spec.ts): Obsidian's way of writing, kept byte for byte where nothing was changed.
  'Writing/Obsidian.md':
    '---\ntags:\n  - alpha\nstatus: draft\n---\n# Obsidian\n\nFirst paragraph with [[Garden]] and ==marked== text.\n\n* star list\n* second\n\n~~~\ntilde code\n~~~\n\nLast paragraph stays.\n',
  'Writing/Quiet.md': '# Quiet\n\nNothing typed here.\n',
  'Writing/Props.md': '---\ntags: [one, two]\nstatus: draft\n---\nBody of the note.\n',
  'Writing/Twice.md': '---\nstatus: draft\n---\nBody.\n',
  'Writing/Outside props.md': '---\nstatus: draft\n---\nBody.\n',
  'Writing/Typing.md': '# Typing\n\nOld text.\n',
  'Writing/Fresh.md': '# Fresh\n\nBefore.\n',
  'Writing/Linking.md': '# Linking\n\nStart.\n',
  'Writing/Target note.md': '# Target note\n',
  'Writing/Source.md': '# Source\n\nPlain text.\n',
  'Writing/Compare.md': '# Compare\n\nKept line.\n\nOld ending.\n',
  // Attachments (attachments.spec.ts).
  'Media/Paste here.md': '# Paste here\n\nStart.\n',
  'Media/Drop here.md': '# Drop here\n\nStart.\n',
  'Media/Gallery.md': '# Gallery\n\n![[sunset.png]]\n\n![Beach](Anh%C3%A4nge/beach.png)\n\nThe [[leaflet.pdf|leaflet]].\n',
  'Media/sunset.png': ORANGE_PNG,
  'Media/Anhänge/beach.png': BLUE_PNG,
  'Media/leaflet.pdf': LEAFLET_PDF,
  'Media/Versions.md': '# Versions\n\nSee [[v1.2]].\n',
  'Media/v1.2.md': '# v1.2\n\nA note whose name ends like a file.\n',
  'Media/Later.md': '# Later\n\nStart.\n',
  'Media/Short lived.md': '# Short lived\n\nStart.\n',
  // A flat folder longer than one page of the sidebar (graph.spec.ts).
  ...Object.fromEntries(Array.from({ length: 620 }, (_, n) => [`Many/Flat/Note ${String(n).padStart(3, '0')}.md`, `# Note ${n}\n`])),
}

const DATA_DIR = external ? '' : dataDir()
/** Where the operator's session is kept for the tests (global-setup.ts signs in once). */
export const SIGNED_IN = path.join(external ? os.tmpdir() : DATA_DIR, 'e2e-operator.json')
process.env.NEXLORE_E2E_STATE = SIGNED_IN
// The project's venv on the development machines, the system Python in CI.
const venv = path.join('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const python = fs.existsSync(path.join('..', 'backend', venv)) ? venv : 'python'

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: external ?? `http://127.0.0.1:${PORT}`,
    headless: true,
    locale: 'en-US',
    storageState: SIGNED_IN,
  },
  webServer: external
    ? undefined
    : {
        command: `${python} -m uvicorn app.main:app --host 127.0.0.1 --port ${PORT}`,
        cwd: path.join('..', 'backend'),
        url: `http://127.0.0.1:${PORT}/api/health`,
        reuseExistingServer: false,
        timeout: 60_000,
        env: {
          NEXLORE_DATA_DIR: DATA_DIR,
          NEXLORE_FRONTEND_DIST: path.resolve('dist'),
          // The watcher and the first scan run as in a real installation: they index the prepared vault.
          NEXLORE_DISABLE_BACKGROUND: '0',
          // The tests make and sign in many accounts; Argon2's strength is not what they measure.
          NEXLORE_ARGON2_TIME: '1',
          NEXLORE_ARGON2_MEMORY_KIB: '8192',
          NEXLORE_ARGON2_PARALLELISM: '1',
        },
      },
})
