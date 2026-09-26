/** The map: sidebar, zoomable graph, breadcrumb, filters and a card for the selected note. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { Sidebar } from '../components/Sidebar'
import { Symbol } from '../components/Symbol'
import { GraphView, type GraphHandle, type Hover } from '../graph/GraphView'
import { formatDate, snippetAround } from '../lib/markdown'
import { ancestry, neighbours, type Cluster } from '../lib/vault'
import { SPACES } from '../mock/notes'
import { useStore } from '../state/store'

const DAILY = 'Mein Wissen/Tagesnotizen'

export function GraphPage() {
  const { t } = useTranslation()
  const { vault, layout } = useStore()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const graph = useRef<GraphHandle>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [focus, setFocus] = useState<Cluster>(vault.root)
  const [hover, setHover] = useState<Hover | null>(null)
  const [hideDaily, setHideDaily] = useState(false)
  const [hintOpen, setHintOpen] = useState(true)

  const hidden = useMemo(() => new Set(hideDaily ? [DAILY] : []), [hideDaily])

  // Search from the header lands here with ?focus=<note>.
  const focusParam = params.get('focus')
  useEffect(() => {
    if (!focusParam) return
    setSelected(focusParam)
    graph.current?.flyToNote(focusParam)
    setParams({}, { replace: true })
  }, [focusParam, setParams])

  const crumbs = useMemo(() => {
    const chain: Cluster[] = []
    for (let c: Cluster | null = focus; c && c.depth > 0; c = c.parent) chain.unshift(c)
    return chain
  }, [focus])

  const selectNote = useCallback((id: string | null) => setSelected(id), [])
  const openNote = useCallback((id: string) => navigate(`/note/${encodeURIComponent(id)}`), [navigate])
  const onFocus = useCallback((cluster: Cluster) => setFocus(cluster), [])

  const note = selected ? vault.notes.get(selected) : null
  const hovered = hover?.kind === 'note' ? vault.notes.get(hover.id) : hover ? vault.clusters.get(hover.id) : null

  return (
    <>
      <Sidebar
        activeNote={selected}
        activeCluster={focus.depth > 0 ? focus.id : null}
        onNote={(id) => {
          setSelected(id)
          graph.current?.flyToNote(id)
        }}
        onCluster={(id) => graph.current?.flyToCluster(id)}
      />
      <main className="relative min-w-0 flex-1 overflow-hidden">
        <GraphView
          ref={graph}
          vault={vault}
          layout={layout}
          selected={selected}
          hidden={hidden}
          onSelect={selectNote}
          onOpen={openNote}
          onFocus={onFocus}
          onHover={setHover}
        />

        {/* Breadcrumb: where on the map the middle of the screen is. */}
        <nav className="pointer-events-auto absolute top-3 left-3 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-1 rounded-full border border-ink-700 bg-ink-900/85 px-1.5 py-1 text-sm backdrop-blur" aria-label={t('graph.position')}>
          <button type="button" onClick={() => graph.current?.fitAll()} className="rounded-full px-2.5 py-0.5 font-medium text-mist-400 hover:bg-ink-800 hover:text-mist-100">
            {t('graph.all')}
          </button>
          {crumbs.map((c) => (
            <span key={c.id} className="flex items-center gap-1">
              <Symbol name="chevronRight" className="h-3.5 w-3.5 text-mist-600" />
              <button type="button" onClick={() => graph.current?.flyToCluster(c.id)} className="flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-medium text-mist-200 hover:bg-ink-800">
                <span className="h-2 w-2 rounded-full" style={{ background: c.color }} />
                {c.name}
              </button>
            </span>
          ))}
        </nav>

        {/* Filters and legend. */}
        <div className="absolute top-3 right-3 hidden w-56 rounded-2xl border border-ink-700 bg-ink-900/85 p-3 text-sm backdrop-blur lg:block">
          <div className="mb-2 text-[11px] font-semibold tracking-wider text-mist-600 uppercase">{t('graph.spaces')}</div>
          <ul className="space-y-1.5">
            {vault.root.children.map((space) => {
              const info = SPACES.find((s) => s.name === space.name)
              return (
                <li key={space.id}>
                  <button type="button" onClick={() => graph.current?.flyToCluster(space.id)} className="flex w-full items-center gap-2 text-left text-mist-300 hover:text-mist-100">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: space.color }} />
                    <span className="flex-1 truncate">{space.name}</span>
                    {info?.shared ? (
                      <span className="inline-flex items-center gap-1 text-[11px] text-mist-500" title={info.members.join(', ')}>
                        <Symbol name="users" className="h-3 w-3" /> {info.members.length}
                      </span>
                    ) : (
                      <Symbol name="lock" className="h-3 w-3 text-mist-600" />
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
          <div className="mt-3 border-t border-ink-700 pt-3">
            <label className="flex cursor-pointer items-center justify-between gap-2 text-mist-300">
              <span>{t('graph.showDaily')}</span>
              <input type="checkbox" checked={!hideDaily} onChange={(e) => setHideDaily(!e.target.checked)} className="h-4 w-4 accent-accent-500" />
            </label>
            <div className="mt-2 flex items-center gap-2 text-xs text-mist-500">
              <span className="inline-block h-2.5 w-2.5 rounded-full border border-dashed border-ai-500" /> {t('common.aiDraft')}
            </div>
          </div>
        </div>

        {/* Zoom controls. */}
        <div className="absolute right-3 bottom-3 flex flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900/85 backdrop-blur">
          <button type="button" onClick={() => graph.current?.zoomBy(1.6)} className="p-2 text-mist-400 hover:bg-ink-800 hover:text-mist-100" title={t('graph.zoomIn')}>
            <Symbol name="plus" />
          </button>
          <button type="button" onClick={() => graph.current?.zoomBy(1 / 1.6)} className="border-t border-ink-700 p-2 text-mist-400 hover:bg-ink-800 hover:text-mist-100" title={t('graph.zoomOut')}>
            <Symbol name="minus" />
          </button>
          <button type="button" onClick={() => graph.current?.fitAll()} className="border-t border-ink-700 p-2 text-mist-400 hover:bg-ink-800 hover:text-mist-100" title={t('graph.fitAll')}>
            <Symbol name="fit" />
          </button>
        </div>

        {/* Hover label for folders and notes. */}
        {hover && hovered && hover.id !== selected && (
          <div className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-ink-700 bg-ink-900/95 px-2.5 py-1.5 text-xs shadow-lg" style={{ left: hover.x, top: hover.y + 8 }}>
            {'title' in hovered ? (
              <>
                <div className="font-semibold text-mist-100">{hovered.title}</div>
                <div className="text-mist-500">
                  {t('graph.noteHover', { count: neighbours(vault, hovered.id).size })}
                </div>
              </>
            ) : (
              <>
                <div className="font-semibold text-mist-100">{hovered.name}</div>
                <div className="text-mist-500">
                  {t('graph.folderHover', { count: hovered.total })}
                </div>
              </>
            )}
          </div>
        )}

        {/* Selected note. */}
        {note && (
          <div className="absolute bottom-3 left-3 w-[min(24rem,calc(100%-5rem))] rounded-2xl border border-ink-700 bg-ink-900/95 p-4 shadow-2xl backdrop-blur">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-mist-500">{ancestry(vault, note.id).map((c) => c.name).join(' › ')}</div>
                <h2 className="mt-0.5 truncate text-lg font-semibold">{note.title}</h2>
              </div>
              <button type="button" onClick={() => setSelected(null)} className="rounded-md p-1 text-mist-500 hover:bg-ink-800 hover:text-mist-100" aria-label={t('common.close')}>
                <Symbol name="close" />
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
              {note.aiDraft && (
                <span className="inline-flex items-center gap-1 rounded-full bg-ai-500/15 px-2 py-0.5 font-medium text-ai-500">
                  <Symbol name="sparkle" className="h-3 w-3" /> {t('common.aiDraft')}
                </span>
              )}
              {note.lockedBy && (
                <span className="inline-flex items-center gap-1 rounded-full bg-warn-500/15 px-2 py-0.5 font-medium text-warn-500">
                  <Symbol name="lock" className="h-3 w-3" /> {t('graph.editingNow', { name: note.lockedBy })}
                </span>
              )}
              <span className="rounded-full bg-ink-800 px-2 py-0.5 text-mist-400">{formatDate(note.updated)}</span>
              <span className="rounded-full bg-ink-800 px-2 py-0.5 text-mist-400">{t('graph.links', { count: (vault.outgoing.get(note.id) ?? []).length })}</span>
              <span className="rounded-full bg-ink-800 px-2 py-0.5 text-mist-400">{t('graph.backlinks', { count: (vault.backlinks.get(note.id) ?? []).length })}</span>
            </div>
            {(vault.backlinks.get(note.id) ?? []).length > 0 && (
              <ul className="mt-3 space-y-1 text-sm">
                {(vault.backlinks.get(note.id) ?? []).slice(0, 3).map((id) => {
                  const from = vault.notes.get(id)!
                  return (
                    <li key={id} className="truncate text-mist-400">
                      <button type="button" onClick={() => { setSelected(id); graph.current?.flyToNote(id) }} className="font-medium text-mist-200 hover:text-accent-400">
                        {from.title}
                      </button>
                      {snippetAround(from.body, note.title) && <span className="text-mist-600"> · {snippetAround(from.body, note.title)}</span>}
                    </li>
                  )
                })}
              </ul>
            )}
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => openNote(note.id)} className="inline-flex items-center gap-2 rounded-full bg-accent-500 px-4 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-400">
                <Symbol name="open" /> {t('graph.open')}
              </button>
              <button type="button" onClick={() => graph.current?.flyToNote(note.id)} className="rounded-full border border-ink-700 px-3.5 py-1.5 text-sm text-mist-300 hover:bg-ink-800">
                {t('graph.flyToNote')}
              </button>
            </div>
          </div>
        )}

        {/* First hint. */}
        {hintOpen && !note && (
          <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full border border-ink-700 bg-ink-900/90 py-1.5 pr-1.5 pl-4 text-xs text-mist-400 backdrop-blur">
            <span>{t('graph.hint')}</span>
            <button type="button" onClick={() => setHintOpen(false)} className="rounded-full p-1 hover:bg-ink-800 hover:text-mist-100" aria-label={t('graph.closeHint')}>
              <Symbol name="close" className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </main>
    </>
  )
}
