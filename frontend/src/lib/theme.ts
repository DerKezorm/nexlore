/**
 * Light or dark mode. The colors behind it live solely in
 * styles/index.css, this only holds which mode is active.
 */
import { useSyncExternalStore } from 'react'


export type Theme = 'dark' | 'light'

const KEY = 'nexlore.theme'

/** The graph listens for this and fetches its colors again. */
export const THEME_EVENT = 'nexlore-theme'

let themeVersion = 0
if (typeof window !== 'undefined') window.addEventListener(THEME_EVENT, () => themeVersion++)
const onTheme = (changed: () => void) => {
  window.addEventListener(THEME_EVENT, changed)
  return () => window.removeEventListener(THEME_EVENT, changed)
}

/** A number that grows with every change of theme: for what works colours out while it draws. */
export function useThemeVersion(): number {
  return useSyncExternalStore(onTheme, () => themeVersion)
}

export function storedTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'light') root.setAttribute('data-theme', 'light')
  else root.removeAttribute('data-theme')
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f5f5f8' : '#0b0b0f')
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // Then the choice only holds until the next reload.
  }
  window.dispatchEvent(new Event(THEME_EVENT))
}
