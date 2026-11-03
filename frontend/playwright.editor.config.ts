/**
 * The editor bundle for the iPhone app, opened as the app opens it: from a file:// URL, with a stand-in for
 * `webkit.messageHandlers.nexlore`. No server: build it first.
 *
 *   node scripts/editor-app-pack.mjs && npx playwright test --config playwright.editor.config.ts
 *
 * WebKit as well as Chromium: the app's web view is WebKit.
 */
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e-editor',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { headless: true, locale: 'de-DE' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['iPhone 15 Pro'] } },
  ],
})
