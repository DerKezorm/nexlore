/**
 * Where plugins appear on a note (M7): panels beside it, code blocks of their language in the reading view, and a
 * view that takes the reading view's place for notes with a key in their front matter (the Kanban board).
 */
import { useLayoutEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import type { NoteData } from '../api/client'
import { Symbol } from '../components/Symbol'
import { PluginFrame } from './host'
import { pluginText, type PluginInfo } from './registry'

type Shared = {
  note: NoteData
  onOpen: (path: string) => void
  onWritten: () => void
}

/** The panels of the switched-on plugins, one below the other. */
export function PluginPanels({ plugins, note, onOpen, onWritten, onReveal }: Shared & { plugins: PluginInfo[]; onReveal: (heading: string, index: number) => void }) {
  const { i18n } = useTranslation()
  const panels = plugins.filter((plugin) => plugin.place.panel)
  if (!panels.length) return null
  return (
    <div className="space-y-4">
      {panels.map((plugin) => (
        <section key={plugin.id} className="rounded-2xl border border-ink-700 bg-ink-900/60 px-3 py-2">
          <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-mist-400">
            <Symbol name="plug" className="h-3.5 w-3.5" /> {pluginText(plugin.name, i18n.language)}
          </h3>
          <PluginFrame plugin={plugin} place="panel" note={note} onOpen={onOpen} onWritten={onWritten} onReveal={onReveal} />
        </section>
      ))}
    </div>
  )
}

type Block = { holder: HTMLElement; plugin: PluginInfo; source: string; key: string }

/**
 * Code blocks of a plugin's language in the rendered note become that plugin's frame. The article's HTML comes from
 * `renderMarkdown`; each such block is swapped for a holder the frame is rendered into (a portal), anew whenever the
 * HTML changes.
 */
export function PluginBlocks({ plugins, article, html, note, onOpen, onWritten }: Shared & { plugins: PluginInfo[]; article: RefObject<HTMLElement | null>; html: string }) {
  const [blocks, setBlocks] = useState<Block[]>([])
  useLayoutEffect(() => {
    const root = article.current
    const found: Block[] = []
    if (root) {
      for (const plugin of plugins) {
        const language = plugin.place.block
        if (!language) continue
        root.querySelectorAll(`pre > code.language-${CSS.escape(language)}`).forEach((code, index) => {
          const pre = code.parentElement!
          const holder = document.createElement('div')
          holder.className = 'nn-plugin-block my-3 rounded-xl border border-ink-700 bg-ink-900/60 px-3 py-2'
          holder.dataset.plugin = plugin.id
          pre.replaceWith(holder)
          // The note's "<" was escaped before Markdown ran; the block's text is what the note says.
          found.push({ holder, plugin, source: (code.textContent ?? '').replaceAll('&lt;', '<'), key: `${plugin.id}-${index}` })
        })
      }
    }
    setBlocks(found)
  }, [article, html, plugins])
  return (
    <>
      {blocks.map((block) =>
        createPortal(
          <PluginFrame plugin={block.plugin} place="block" note={note} source={block.source} onOpen={onOpen} onWritten={onWritten} />,
          block.holder,
          block.key,
        ),
      )}
    </>
  )
}

/** A switch between the plugin's view and the note's text, above the reading view. */
export function ViewSwitch({ plugin, showText, onChange }: { plugin: PluginInfo; showText: boolean; onChange: (text: boolean) => void }) {
  const { t, i18n } = useTranslation()
  const label = plugin.strings[i18n.language]?.view ?? plugin.strings.en?.view ?? pluginText(plugin.name, i18n.language)
  const options: [boolean, string][] = [
    [false, label],
    [true, t('plugins.text')],
  ]
  return (
    <div role="radiogroup" aria-label={t('plugins.showAs')} className="mb-3 inline-flex rounded-full border border-ink-700 p-0.5 text-xs">
      {options.map(([text, name]) => (
        <button
          key={name}
          type="button"
          role="radio"
          aria-checked={showText === text}
          onClick={() => onChange(text)}
          className={'rounded-full px-3 py-1 ' + (showText === text ? 'bg-accent-500/15 text-accent-400' : 'text-mist-400 hover:text-mist-100')}
        >
          {name}
        </button>
      ))}
    </div>
  )
}
