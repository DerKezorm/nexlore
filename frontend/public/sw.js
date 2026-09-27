/*
 * nexlore's service worker (M6): it makes the app installable and keeps the app itself (the page, its scripts and
 * styles, the icons) for a quick start. Nothing else.
 *
 * - Never anything under /api: that is what rights protect, and a copy would outlive a sign-out or a lost right.
 * - Never anything of another origin: it passes by untouched (a worker that answered for foreign images once broke
 *   the covers of another nex app).
 * - Pages always from the network first; the kept page only when the network is gone. Scripts and styles under
 *   /assets/ carry their content in their name, so a kept one is always right.
 * - Signing out empties every cache (the page asks, see lib/offline.ts).
 *
 * Working offline is for later, first as a copy to read.
 */
const CACHE = 'nexlore-app-v1'
const SHELL = ['/', '/manifest.webmanifest', '/logo.svg', '/theme.js', '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((path) => new Request(path, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'clear') {
    event.waitUntil(caches.keys().then((names) => Promise.all(names.map((name) => caches.delete(name)))))
  }
})

function kept(request) {
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return false
  return !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api?')
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (!kept(request)) return
  const url = new URL(request.url)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Every page of the app is the same index.html; the newest one is kept for the way back offline.
          if (response.ok && (response.headers.get('content-type') || '').startsWith('text/html')) {
            const copy = response.clone()
            caches.open(CACHE).then((cache) => cache.put('/', copy))
          }
          return response
        })
        .catch(() => caches.match('/').then((found) => found || Response.error())),
    )
    return
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (found) =>
          found ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone()
              caches.open(CACHE).then((cache) => cache.put(request, copy))
            }
            return response
          }),
      ),
    )
    return
  }
  if (SHELL.includes(url.pathname)) {
    // The icons and the like: the kept one at once, a fresh one fetched for next time.
    event.respondWith(
      caches.match(request).then((found) => {
        const fresh = fetch(request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone()
              caches.open(CACHE).then((cache) => cache.put(request, copy))
            }
            return response
          })
          .catch(() => found || Response.error())
        return found || fresh
      }),
    )
  }
})
