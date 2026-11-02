/**
 * The editor alone, for the iPhone app: editor-app.html into dist-editor/, every path relative (`base: './'`), so
 * the app opens it from a file:// URL. One classic script instead of modules: a module script does not load from
 * file:// in Chromium, and nothing promises that it does in the app's web view. Without `public/`: the app's
 * service worker, icons and pdf.js stay out.
 *
 *   node scripts/editor-app-pack.mjs     builds this and writes dist-editor/manifest.json
 */
import fs from 'node:fs'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'

/** nexlore's version, from the one place the server reads it. */
const version = /__version__\s*=\s*"([^"]+)"/.exec(fs.readFileSync(new URL('../backend/app/__init__.py', import.meta.url), 'utf8'))![1]

/** Vite writes `<script type="module" crossorigin>`; a file:// page would refuse both. A plain deferred script. */
function classicScript(): Plugin {
  return {
    name: 'nexlore-classic-script',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) => html.replace(/<script type="module" crossorigin /g, '<script defer ').replace(/ crossorigin(?=[ >])/g, ''),
    },
  }
}

export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [react(), tailwindcss(), classicScript()],
  define: { __NEXLORE_VERSION__: JSON.stringify(version) },
  build: {
    outDir: 'dist-editor',
    emptyOutDir: true,
    modulePreload: false,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 20_000,
    rollupOptions: {
      input: { 'editor-app': 'editor-app.html' },
      output: { format: 'iife', inlineDynamicImports: true },
    },
  },
})
