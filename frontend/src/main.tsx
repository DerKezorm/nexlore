import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import App from './App'
import { startI18n } from './i18n'
import { defaultCalloutCss } from './lib/callouts'
import { registerServiceWorker } from './lib/offline'
import { installRovingKeys } from './lib/rovingKeys'
import { AuthProvider } from './state/auth'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles/index.css'

registerServiceWorker()

// The symbols of the callout kinds, for every page; a theme may change them (lib/callouts.ts).
const calloutSymbols = document.createElement('style')
calloutSymbols.id = 'nexlore-callout-symbols'
calloutSymbols.textContent = defaultCalloutCss()
document.head.append(calloutSymbols)

// The texts first, so the first paint is already in the chosen language.
// Tabs and option groups answer the arrows (P8.14).
installRovingKeys()

void startI18n().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </StrictMode>,
  )
})
