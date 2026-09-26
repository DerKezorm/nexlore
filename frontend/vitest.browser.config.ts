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
