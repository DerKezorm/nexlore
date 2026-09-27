/** The plugins of this account (M7): what the server let out and this account switched on, and helpers. */
import { useEffect, useState } from 'react'

import { api, type NoteData } from '../api/client'

export type PluginPlace = { panel?: true; block?: string; view?: { frontmatter: string } }
export type PluginInfo = {
  id: string
  version: string
  author: string
  name: Record<string, string>
  description: Record<string, string>
  permissions: string[]
  place: PluginPlace
  strings: Record<string, Record<string, string>>
  source: 'catalog' | 'upload'
  enabled: boolean
}

export const pluginsApi = {
  mine: () => api<PluginInfo[]>('/api/plugins'),
  enable: (id: string, enabled: boolean) => api<PluginInfo>(`/api/plugins/${id}/enabled`, { method: 'PUT', body: { enabled } }),
}

/** A text of a plugin's manifest in the interface language, English when it has none. */
export function pluginText(texts: Record<string, string>, language: string): string {
  return texts[language] ?? texts[language.split('-')[0]] ?? texts.en ?? ''
}

let cached: Promise<PluginInfo[]> | null = null
const listeners = new Set<() => void>()

/** Forget the list (a plugin was switched on or off): every page asks again. */
export function pluginsChanged() {
  cached = null
  for (const listener of listeners) listener()
}

/** The plugins this account switched on, of those the operator let out. */
export function useEnabledPlugins(): PluginInfo[] {
  const [list, setList] = useState<PluginInfo[]>([])
  const [round, setRound] = useState(0)
  useEffect(() => {
    const again = () => setRound((value) => value + 1)
    listeners.add(again)
    return () => {
      listeners.delete(again)
    }
  }, [])
  useEffect(() => {
    let live = true
    cached ??= pluginsApi.mine().catch(() => [])
    void cached.then((found) => live && setList(found.filter((plugin) => plugin.enabled)))
    return () => {
      live = false
    }
  }, [round])
  return list
}

/** The plugin whose view takes the place of the reading view for this note, if any. */
export function viewFor(plugins: PluginInfo[], note: NoteData): PluginInfo | null {
  const front = note.front && typeof note.front === 'object' ? (note.front as Record<string, unknown>) : null
  if (!front) return null
  return plugins.find((plugin) => plugin.place.view && plugin.place.view.frontmatter in front) ?? null
}
