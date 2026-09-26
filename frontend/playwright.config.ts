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
  process.env.NEXLORE_E2E_DATA = dir
  return dir
}

const DATA_DIR = external ? '' : dataDir()
// The project's venv on the development machines, the system Python in CI.
const venv = path.join('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const python = fs.existsSync(path.join('..', 'backend', venv)) ? venv : 'python'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: external ?? `http://127.0.0.1:${PORT}`,
    headless: true,
    locale: 'en-US',
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
          NEXLORE_DISABLE_BACKGROUND: '1',
        },
      },
})
