/**
 * Tests that need a real browser: the editor (Milkdown does not run in jsdom). Chromium, headless, through
 * Playwright, the same browser the end-to-end tests use.
 *
 *   npm run test:browser
 */
import react from '@vitejs/plugin-react'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  // Found only while a test runs, these would be bundled a second time and Vite reloads the test: the editor's
  // toolbar then asks Crepe for a link box of another copy ("not found"), and the previews under code blocks lose
  // lib/enrich.ts on the way (seen on a fresh CI machine only; a local cache hides it). Bundled from the start instead.
  optimizeDeps: {
    include: [
      '@milkdown/kit/component/link-tooltip',
      '@milkdown/kit/component/list-item-block',
      'vue',
      '@milkdown/kit/prose/history',
      '@milkdown/kit/prose/keymap',
      '@milkdown/kit/prose/schema-list',
      '@milkdown/kit/prose/tables',
      'katex',
      'mermaid',
      '@codemirror/language',
      '@codemirror/language-data',
      '@lezer/highlight',
    ],
  },
  test: {
    include: ['src/**/*.browser.test.{ts,tsx}'],
    globals: true,
    testTimeout: 60_000,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      screenshotFailures: false,
      // A fixed port: a random one can land in a range Windows reserves (EACCES).
      api: { host: '127.0.0.1', port: 5479, strictPort: true },
      instances: [{ browser: 'chromium' }],
    },
  },
})
