import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The notes still come from src/mock; languages and everything else under /api come from the backend on 8470.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // The app, and the frame that shows PDFs (its own page, without an origin: see src/pdfview/main.ts).
    rollupOptions: { input: { main: 'index.html', pdfview: 'pdfview.html' } },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    css: false,
    exclude: ['node_modules/**', 'dist/**', 'e2e/**', 'src/**/*.browser.test.{ts,tsx}'],
  },
  server: {
    // Fixed port: if it is taken, Vite aborts instead of silently falling back to another one.
    port: 5470,
    strictPort: true,
    proxy: {
      // changeOrigin off: the backend sees the browser's own host, as it will behind a reverse proxy.
      '/api': { target: 'http://127.0.0.1:8470', changeOrigin: false },
    },
  },
})
