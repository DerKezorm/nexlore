/**
 * The service worker (M6, `public/sw.js`): registered in the built app only (the development server has no worker,
 * and its modules change with every save). Signing out empties every cache it keeps.
 */

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Not installable then; the app works as before.
    })
  })
}

/** Every cache of this origin gone, and the worker told so (it may hold a request in flight). */
export async function clearCaches(): Promise<void> {
  try {
    navigator.serviceWorker?.controller?.postMessage('clear')
    if ('caches' in window) {
      const names = await caches.keys()
      await Promise.all(names.map((name) => caches.delete(name)))
    }
  } catch {
    // Nothing kept, or the browser does not let us: nothing to clear.
  }
}
