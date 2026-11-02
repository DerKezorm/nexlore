/**
 * nexlore's editor alone, for the iPhone app (nexlore-ios, docs/editor-bruecke.md): no router, no sign-in, no
 * network, no plugins, no AI, no comments. Built by scripts/editor-app-pack.mjs into dist-editor/, which the app opens
 * from a file:// URL in its web view. The app drives it through `window.nexloreEditor` (bridge.ts) and hears from it
 * through `webkit.messageHandlers.nexlore`.
 */
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import '@milkdown/crepe/theme/common/style.css'
import '../styles/index.css'
import '../styles/editor.css'
import './editorapp.css'

import { createBridge, type Message } from './bridge'
import { startEditorI18n } from './i18n'

declare const __NEXLORE_VERSION__: string

type Handlers = { nexlore?: { postMessage: (message: unknown) => void } }

declare global {
  interface Window {
    webkit?: { messageHandlers?: Handlers }
    nexloreEditor?: unknown
  }
}

function post(message: Message): void {
  window.webkit?.messageHandlers?.nexlore?.postMessage(message)
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
window.addEventListener('error', (event) => post({ type: 'error', message: event.message || errorText(event.error) }))
window.addEventListener('unhandledrejection', (event) => post({ type: 'error', message: errorText(event.reason) }))

// Nothing opens a window of its own (Crepe's link preview would): a web address goes to the app.
window.open = (url?: string | URL) => {
  if (url) post({ type: 'openLink', target: String(url), kind: 'url' })
  return null
}

void startEditorI18n(navigator.language || 'en').then(
  () => {
    const bridge = createBridge(document.getElementById('editor')!, post)
    window.nexloreEditor = Object.freeze({
      load: bridge.load,
      setText: bridge.setText,
      setTheme: bridge.setTheme,
      setReadOnly: bridge.setReadOnly,
      command: bridge.command,
      answer: bridge.answer,
      focus: bridge.focus,
      blur: bridge.blur,
    })
    post({ type: 'ready', version: __NEXLORE_VERSION__ })
  },
  (error: unknown) => post({ type: 'error', message: errorText(error) }),
)
