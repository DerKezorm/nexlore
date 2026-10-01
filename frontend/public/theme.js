// Before the first paint: otherwise the dark side briefly flashes when "light" is set.
// Own file instead of an inline script, because the server's Content Security Policy only allows its own files.
try {
  var mode = localStorage.getItem('nexlore.mode')
  var light =
    // Nobody chose yet (the sign-in page of a new browser): as the system is set.
    mode === 'system' || mode === null
      ? window.matchMedia('(prefers-color-scheme: light)').matches
      : localStorage.getItem('nexlore.theme') === 'light'
  if (light) {
    document.documentElement.setAttribute('data-theme', 'light')
    document.querySelector('meta[name="theme-color"]').content = '#f5f5f8'
  }
} catch (e) {
  /* private mode without localStorage */
}
