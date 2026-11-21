/* The icons for the home screen, rendered once from the light version of the mark.
 *
 * Same shape as components/Logo.tsx and public/logo.svg; the source of every version is nexapps/icons-vergleich/neu.py.
 * Rendered with Playwright, which the end-to-end tests bring anyway:  node scripts/app-icons.mjs
 *
 * The maskable icon is cropped by Android to a shape of its choosing; everything outside the inner 80 percent may go,
 * so the mark sits smaller on a full white square there. The Apple touch icon is full bleed: iOS rounds it itself.
 */
import { chromium } from '@playwright/test'

const VERLAUF = `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="10" y1="10" x2="54" y2="54">
  <stop offset="0" stop-color="#7fe0d0"/><stop offset=".5" stop-color="#1fb5a2"/><stop offset="1" stop-color="#0b5f57"/>
</linearGradient></defs>`
const ZEICHEN = `<g transform="translate(0 -1.5)">
<path d="M20.5 25 30 16 42 21.5M30 16 34 25.5" fill="none" stroke="#0e8f82" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="20.5" cy="25" r="3.6" fill="#0e8f82" stroke="#fff" stroke-width="1.8"/>
<circle cx="42" cy="21.5" r="3.6" fill="#0e8f82" stroke="#fff" stroke-width="1.8"/>
<circle cx="34" cy="25.5" r="3.4" fill="#0e8f82" stroke="#fff" stroke-width="1.8"/>
<circle cx="30" cy="16" r="4.6" fill="#0e8f82" stroke="#fff" stroke-width="1.8"/>
<path d="M15 28.5H49L45.5 44H18.5Z" fill="#fff" stroke="url(#g)" stroke-width="4.2" stroke-linejoin="round"/>
<path d="M12.5 28.5H51.5" stroke="url(#g)" stroke-width="4.2" stroke-linecap="round"/>
<path d="M17.6 36.2H46.4" stroke="url(#g)" stroke-width="2.6" stroke-opacity=".6"/>
<circle cx="22" cy="40" r="1.3" fill="url(#g)" opacity=".6"/>
<circle cx="42" cy="40" r="1.3" fill="url(#g)" opacity=".6"/>
<circle cx="22" cy="32.4" r="1.3" fill="url(#g)" opacity=".6"/>
<circle cx="42" cy="32.4" r="1.3" fill="url(#g)" opacity=".6"/>
<path d="M11 52.5H53" stroke="url(#g)" stroke-width="2.6" stroke-linecap="round" stroke-opacity=".55"/>
<circle cx="24.5" cy="47" r="4.4" fill="url(#g)" stroke="#fff" stroke-width="2"/>
<circle cx="39.5" cy="47" r="4.4" fill="url(#g)" stroke="#fff" stroke-width="2"/>
</g>`

const kachel = (s) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${s}" height="${s}">${VERLAUF}
  <rect x="2" y="2" width="60" height="60" rx="16" fill="#fff"/>
  <rect x="2.75" y="2.75" width="58.5" height="58.5" rx="15.3" fill="none" stroke="#1fb5a2" stroke-opacity=".35" stroke-width="1.5"/>
  ${ZEICHEN}</svg>`
const voll = (s, m) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${s}" height="${s}">${VERLAUF}
  <rect width="64" height="64" fill="#fff"/>
  <g transform="translate(32 32) scale(${m}) translate(-32 -32)">${ZEICHEN}</g></svg>`
const randlos = (s) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="2 2 60 60" width="${s}" height="${s}">${VERLAUF}
  <rect x="2" y="2" width="60" height="60" fill="#fff"/>${ZEICHEN}</svg>`

const BILDER = [
  ['public/icons/icon-192.png', kachel(192), 192],
  ['public/icons/icon-512.png', kachel(512), 512],
  ['public/icons/icon-maskable-512.png', voll(512, 0.78), 512],
  ['public/icons/apple-touch-icon.png', randlos(180), 180],
]

const browser = await chromium.launch()
for (const [pfad, svg, groesse] of BILDER) {
  const seite = await browser.newPage({ viewport: { width: groesse, height: groesse } })
  await seite.setContent(`<body style="margin:0;background:transparent">${svg}</body>`)
  await seite.locator('svg').screenshot({ path: pfad, omitBackground: true })
  await seite.close()
  console.log('written:', pfad)
}
await browser.close()
