/**
 * The page's side of the plugin API (M7). A plugin lives in a sandboxed frame without an origin of its own
 * (`sandbox="allow-scripts"`, no `allow-same-origin`): no cookie, no storage of the app, no request that could
 * carry the session. Its frame's own policy forbids every connection (`services/plugins.py`), and the app's policy
 * (`frame-src` through `default-src 'self'`) keeps the frame from navigating anywhere else.
 *
 * All a plugin can do is ask here, by `postMessage`. A message counts only when it comes from that frame's window,
 * and a request is answered only when the plugin's manifest lists the permission it needs. The answers come from the
 * app's routes with the account's own rights, so a plugin never sees more than the person looking at it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api, type NoteData } from '../api/client'
import { isNotePath, pluginText, type PluginInfo } from './registry'

const THEME: Record<string, string> = {
  '--bg': '--color-ink-950',
  '--card': '--color-ink-900',
  '--fg': '--color-mist-200',
  '--muted': '--color-mist-500',
  '--border': '--color-ink-700',
  '--accent': '--color-accent-400',
  '--warn': '--color-warn-500',
}

function theme(): Record<string, string> {
  const style = getComputedStyle(document.documentElement)
  return Object.fromEntries(Object.entries(THEME).map(([name, token]) => [name, style.getPropertyValue(token).trim()]))
}

type Request = { nx: 1; id?: number; method?: string; args?: Record<string, unknown> }

export type PluginFrameProps = {
  plugin: PluginInfo
  place: 'panel' | 'block' | 'view'
  /** The note it sits on. */
  note: NoteData
  /** The text of the code block, for a block. */
  source?: string
  onOpen: (path: string) => void
  /** A heading of the note to bring into view (the contents panel). */
  onReveal?: (heading: string, index: number) => void
  /** The plugin wrote the note: the page loads it again. */
  onWritten: () => void
  className?: string
}

const QUERY_KEYS = ['tag', 'folder', 'space', 'sort', 'limit', 'random', 'day'] as const

export function PluginFrame({ plugin, place, note, source, onOpen, onReveal, onWritten, className = '' }: PluginFrameProps) {
  const { i18n } = useTranslation()
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(place === 'view' ? 480 : 60)
  // The newest note and callbacks, read when a request comes; the frame is not made again for them.
  const current = useRef({ note, onOpen, onReveal, onWritten })
  current.current = { note, onOpen, onReveal, onWritten }
  const title = pluginText(plugin.name, i18n.language)

  const send = useCallback((message: Record<string, unknown>) => {
    // The frame has no origin ("null"): '*' is the only target there is. What goes there is only what the plugin
    // may see, and only to this frame's own window.
    frame.current?.contentWindow?.postMessage({ nx: 1, ...message }, '*')
  }, [])

  const init = useCallback(() => {
    const language = i18n.language
    send({
      event: 'init',
      value: {
        place,
        path: current.current.note.path,
        language,
        strings: plugin.strings[language] ?? plugin.strings[language.split('-')[0]] ?? plugin.strings.en ?? {},
        theme: theme(),
        source: source ?? '',
      },
    })
  }, [i18n.language, place, plugin.strings, send, source])

  // The note changed (saved, reloaded): plugins that read it read it again.
  const noteHash = note.hash
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    send({ event: 'changed', value: { path: current.current.note.path } })
  }, [noteHash, send])

  useEffect(() => {
    const may = (permission: string) => plugin.permissions.includes(permission)
    const answer = async (method: string, args: Record<string, unknown>): Promise<unknown> => {
      const { note: shown } = current.current
      switch (method) {
        case 'note.read':
          if (!may('note:read')) throw new Error('not_allowed')
          return { path: shown.path, title: shown.title, content: shown.content, hash: shown.hash }
        case 'note.write': {
          if (!may('note:write') || typeof args.content !== 'string' || typeof args.base_hash !== 'string') throw new Error('not_allowed')
          const result = await api<{ saved: boolean; conflict: string | null; hash: string }>('/api/plugins/note', {
            method: 'PUT',
            body: { plugin: plugin.id, path: shown.path, content: args.content, base_hash: args.base_hash },
          })
          current.current.onWritten()
          return result
        }
        case 'vault.query': {
          if (!may('vault:read')) throw new Error('not_allowed')
          const query: Record<string, string> = {}
          for (const key of QUERY_KEYS) {
            const value = args[key]
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') query[key] = String(value).slice(0, 1024)
          }
          return api('/api/plugins/query', { query })
        }
        case 'note.open':
          // Only to a note, and only for a plugin that may read: no plugin sends the app to any address it likes.
          if (!may('note:read') && !may('vault:read')) throw new Error('not_allowed')
          if (typeof args.path !== 'string' || !isNotePath(args.path)) throw new Error('not_allowed')
          current.current.onOpen(args.path)
          return null
        case 'note.reveal':
          if (typeof args.heading !== 'string') throw new Error('not_allowed')
          current.current.onReveal?.(args.heading, typeof args.index === 'number' ? args.index : 0)
          return null
        default:
          throw new Error('not_allowed')
      }
    }
    const listen = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const message = event.data as Request
      if (!message || message.nx !== 1 || typeof message.method !== 'string') return
      const args = message.args && typeof message.args === 'object' ? message.args : {}
      if (message.method === 'resize') {
        const wanted = Number(args.height)
        if (Number.isFinite(wanted)) setHeight(Math.max(24, Math.min(place === 'view' ? 4000 : 1200, Math.ceil(wanted))))
        return
      }
      if (typeof message.id !== 'number') return
      answer(message.method, args).then(
        (value) => send({ reply: message.id, value }),
        (error: unknown) => send({ reply: message.id, error: error instanceof Error ? error.message : 'failed' }),
      )
    }
    window.addEventListener('message', listen)
    return () => window.removeEventListener('message', listen)
  }, [plugin.id, plugin.permissions, place, send])

  return (
    <iframe
      ref={frame}
      title={title}
      src={`/api/plugins/${plugin.id}/frame`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={init}
      data-plugin={plugin.id}
      style={{ height }}
      className={'block w-full border-0 bg-transparent ' + className}
    />
  )
}
