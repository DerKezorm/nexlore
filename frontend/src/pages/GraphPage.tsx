/** The map: sidebar, zoomable graph, clouds (folders, tags, topics), breadcrumb, filters and a card for the chosen note. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { graphApi, vaultApi, type Cloud, type Links } from '../api/client'
import { Sidebar } from '../components/Sidebar'
import { Symbol } from '../components/Symbol'
import { GraphView, type GraphHandle, type Hover } from '../graph/GraphView'
import { spaceColor } from '../graph/palette'
import type { SceneGroup } from '../graph/scene'
import { useGraph } from '../graph/useGraph'
import { homeSpace } from '../lib/everyday'
import { lookOf } from '../lib/looks'
import { formatDate } from '../lib/markdown'
import { askNewNote } from '../lib/newNote'
import { askVaultAction } from '../lib/vaultActions'
import { folderOf, noteUrl } from '../lib/vault'
import { useStore } from '../state/store'
import { useAuth } from '../state/auth'

const CLOUD_KEY = 'nexlore.graph.cloud'
const DAILY_KEY = 'nexlore.graph.daily'
const CLOUDS: Cloud[] = ['folders', 'tags', 'topics']
const FIRST_STEP = 'inline-flex items-center gap-2 rounded-full bg-accent-500 px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-400'

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key) as T | null
    return value && allowed.includes(value) ? value : fallback
  } catch {
    return fallback
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Then it holds until the page is left.
  }
}

type Chosen = { id: number; path: string; title: string }

export function GraphPage() {
  const { t } = useTranslation()
  const { me, setAppearance } = useAuth()
  const { spaces, generation, status, scan, looks } = useStore()
  const home = homeSpace(spaces, me?.appearance?.home_space)
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const graph = useRef<GraphHandle>(null)
  const [cloud, setCloudState] = useState<Cloud>(() => stored(CLOUD_KEY, CLOUDS, 'folders'))
  const [hideDaily, setHideDaily] = useState(() => stored(DAILY_KEY, ['hide', 'show'] as const, 'show') === 'hide')
  const [chosen, setChosen] = useState<Chosen | null>(null)
  const [links, setLinks] = useState<Links | null>(null)
  const [centre, setCentre] = useState<SceneGroup | null>(null)
  const [hover, setHover] = useState<Hover | null>(null)
  const [hintOpen, setHintOpen] = useState(true)
  const [sheet, setSheet] = useState(false)
  // The spaces left out of the map, with the account. Every one left out (chosen elsewhere, or the last one shown is
  // gone): the map shows them all rather than nothing.
  const hiddenIds = me?.appearance?.graph_hidden
  const hidden = useMemo(() => {
    const ids = new Set(hiddenIds ?? [])
    return spaces.some((space) => !ids.has(space.id)) ? ids : new Set<number>()
  }, [hiddenIds, spaces])
  const data = useGraph(spaces, cloud, generation, looks, hidden)
  const { scene, revision, overviews } = data
  const refit = useRef(false)

  const chooseHidden = useCallback(
    (ids: Set<number>) => {
      refit.current = true
      void setAppearance({ graph_hidden: spaces.filter((space) => ids.has(space.id)).map((space) => space.id) }).catch(() => undefined)
    },
    [setAppearance, spaces],
  )
  /** A space asked for on the map (a note or folder from the sidebar, a search) comes back onto it. */
  const reveal = useCallback(
    (name: string) => {
      const space = spaces.find((item) => item.name === name)
      if (!space || !hidden.has(space.id)) return
      const next = new Set(hidden)
      next.delete(space.id)
      chooseHidden(next)
    },
    [spaces, hidden, chooseHidden],
  )

  // After a new choice of spaces, the map fits them all once they are there.
  useEffect(() => {
    if (!refit.current) return
    const wanted = spaces.filter((space) => !hidden.has(space.id)).map((space) => space.name)
    const shown = scene.spaces.map((space) => space.name)
    if (shown.length === wanted.length && wanted.every((name) => shown.includes(name))) {
      refit.current = false
      graph.current?.fitAll()
    }
  }, [revision, scene, spaces, hidden])

  const setCloud = (next: Cloud) => {
    setCloudState(next)
    remember(CLOUD_KEY, next)
    setSheet(false)
  }

  const groupLabel = useCallback(
    (group: SceneGroup): string => {
      switch (group.kind) {
        case 'tag':
          return '#' + group.name
        case 'untagged':
          return t('graph.untagged')
        case 'recent':
          return t('graph.recent')
        case 'unsorted':
          return t('graph.unsorted')
        case 'bucket':
          return group.name ? t('graph.around', { title: group.name }) : t('graph.group')
        case 'unlinked':
          return group.name ? t('graph.unlinkedRange', { range: group.name }) : t('graph.unlinked')
        default:
          return group.name
      }
    },
    [t],
  )
  const countLabel = useCallback((count: number) => t('graph.notes', { count }), [t])

  // The card of the chosen note: its links and backlinks come from the server.
  useEffect(() => {
    setLinks(null)
    if (!chosen) return
    let live = true
    vaultApi.links(chosen.path).then((found) => live && setLinks(found), () => undefined)
    return () => {
      live = false
    }
  }, [chosen])

  const select = useCallback(
    (id: number | null) => {
      if (id === null) return setChosen(null)
      const note = scene.notes.get(id)
      if (note) setChosen({ id, path: note.path, title: note.title })
    },
    [scene],
  )

  // A note asked for before the map of its space has come (a click in the sidebar on a slow server): kept, and
  // flown to once the space is there, instead of the click going nowhere.
  const [waiting, setWaiting] = useState<{ path: string; title?: string } | null>(null)

  /** Fly to a note by its path (search, sidebar, backlinks). */
  const focusPath = useCallback(
    async (path: string, title?: string) => {
      if (!scene.space(path.split('/')[0])) {
        reveal(path.split('/')[0])
        setWaiting({ path, title })
        return
      }
      try {
        const place = await graphApi.locate(path, cloud)
        const space = scene.space(path.split('/')[0])
        const home = scene.groups.get(place.group)
        if (!space) return
        setChosen({ id: place.id, path, title: title ?? scene.notes.get(place.id)?.title ?? path.split('/').pop()!.replace(/\.md$/i, '') })
        graph.current?.flyToPoint(place.x + space.ox, place.y + space.oy, home?.r ?? 200)
      } catch {
        // A note the graph does not know (yet): nothing to fly to.
      }
    },
    [cloud, scene, reveal],
  )

  // Search from the header lands here with ?focus=<note>, once the map is there.
  const focusParam = params.get('focus')
  const ready = scene.spaces.length > 0
  useEffect(() => {
    if (!focusParam || !ready) return
    void focusPath(focusParam)
    setParams({}, { replace: true })
  }, [focusParam, ready, focusPath, setParams])
  useEffect(() => {
    if (!waiting || !scene.space(waiting.path.split('/')[0])) return
    setWaiting(null)
    void focusPath(waiting.path, waiting.title)
  }, [waiting, scene, revision, focusPath])

  const flyToFolder = useCallback(
    (path: string) => {
      const parts = path.split('/')
      if (!scene.space(parts[0])) {
        // Left out of the map: back onto it, and flown to once it is there.
        reveal(parts[0])
        setParams({ folder: path }, { replace: true })
        return
      }
      const key = parts.length === 1 ? 'space' : 'f:' + parts.slice(1).join('/')
      for (const group of scene.groups.values()) {
        if (group.space === parts[0] && group.key === key) return graph.current?.flyToGroup(group.id)
      }
    },
    [scene, reveal, setParams],
  )

  // "Show in the graph" from the sidebar of another page lands here with ?folder=<folder>, once its space is there.
  const folderParam = params.get('folder')
  useEffect(() => {
    if (!folderParam) return
    if (!scene.space(folderParam.split('/')[0])) return reveal(folderParam.split('/')[0])
    flyToFolder(folderParam)
    setParams({}, { replace: true })
  }, [folderParam, scene, revision, flyToFolder, setParams, reveal])

  const crumbs = useMemo(() => {
    const chain: SceneGroup[] = []
    for (let g: SceneGroup | undefined = centre ?? undefined; g; g = g.parent !== null ? scene.groups.get(g.parent) : undefined) chain.unshift(g)
    return chain
  }, [centre, scene])

  // Every space the account may read, shown on the map or not; one left out keeps its colour and the count of its notes.
  const spaceRows = useMemo(
    () =>
      spaces.map((space, index) => {
        const placed = scene.space(space.name)
        const root = placed ? scene.groups.get(placed.root) : undefined
        return {
          name: space.name,
          space: space.id,
          root: root?.id ?? null,
          shown: !hidden.has(space.id),
          color: root?.color ?? lookOf(looks, space.name).color ?? spaceColor(index),
          total: root?.total ?? (hidden.has(space.id) ? space.notes : 0),
        }
      }),
    // The scene changes in place; the revision says when.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scene, revision, spaces, hidden, looks],
  )
  const total = spaceRows.reduce((sum, row) => sum + (row.shown ? row.total : 0), 0)
  const shownCount = spaceRows.filter((row) => row.shown).length
  const manageable = Object.entries(overviews).filter(([, overview]) => overview.manage).map(([name]) => name)
  const topicsBuilt = Object.values(overviews)
    .map((overview) => overview.built)
    .filter((value): value is string => !!value)
    .sort()
    .at(-1)
  const working = Object.values(overviews).some((overview) => overview.working || overview.status === 'building')

  const askTopics = async () => {
    await Promise.all(manageable.map((name) => graphApi.topics(name).catch(() => undefined)))
    data.refresh()
  }

  const hoveredNote = hover?.kind === 'note' ? scene.notes.get(hover.id) : null
  const hoveredGroup = hover?.kind === 'group' ? scene.groups.get(hover.id) : null

  const cloudSwitch = (
    <div className="inline-flex rounded-full border border-ink-700 bg-ink-900/85 p-0.5 text-sm backdrop-blur" role="radiogroup" aria-label={t('graph.clouds')}>
      {CLOUDS.map((key) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={cloud === key}
          onClick={() => setCloud(key)}
          className={'rounded-full px-3 py-1 font-medium ' + (cloud === key ? 'bg-accent-500/15 text-accent-400' : 'text-mist-400 hover:text-mist-100')}
        >
          {t(`graph.cloud.${key}`)}
        </button>
      ))}
    </div>
  )

  const cloudInfo =
    cloud === 'topics' ? (
      <div className="text-xs text-mist-500">
        {working ? (
          <div role="status">{t('graph.topicsWorking')}</div>
        ) : (
          topicsBuilt && <div>{t('graph.topicsBuilt', { when: formatDate(topicsBuilt) })}</div>
        )}
        <div className="mt-0.5">{t('graph.topicsFrom')}</div>
        {manageable.length > 0 && (
          <button
            type="button"
            onClick={() => void askTopics()}
            disabled={working}
            className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-ink-700 px-3 py-1 text-mist-300 hover:bg-ink-800 disabled:opacity-50"
          >
            <Symbol name="refresh" className="h-3.5 w-3.5" /> {t('graph.topicsAgain')}
          </button>
        )}
      </div>
    ) : cloud === 'tags' ? (
      <p className="text-xs text-mist-500">{t('graph.tagsInfo')}</p>
    ) : null

  const dailyToggle = (
    <label className="flex cursor-pointer items-center justify-between gap-2 text-mist-300">
      <span>{t('graph.showDaily')}</span>
      <input
        type="checkbox"
        checked={!hideDaily}
        onChange={(event) => {
          setHideDaily(!event.target.checked)
          remember(DAILY_KEY, event.target.checked ? 'show' : 'hide')
        }}
        className="h-4 w-4 accent-accent-500"
      />
    </label>
  )

  // Each space with a box: shown on the map or left out (with the account). The name flies there, and brings a space
  // left out back; "Only this one" leaves out all the others.
  const spaceList = (
    <ul className="space-y-1.5" data-testid="graph-spaces">
      {spaceRows.map((space) => {
        const last = space.shown && shownCount === 1
        return (
          <li key={space.name} className="group flex items-center gap-2">
            <input
              type="checkbox"
              checked={space.shown}
              disabled={last}
              title={last ? t('graph.lastSpace') : undefined}
              aria-label={t('graph.showSpace', { name: space.name })}
              onChange={() => {
                const next = new Set(hidden)
                if (space.shown) next.add(space.space)
                else next.delete(space.space)
                chooseHidden(next)
              }}
              className="h-3.5 w-3.5 shrink-0 accent-accent-500 disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => {
                setSheet(false)
                if (!space.shown) return reveal(space.name)
                if (space.root !== null) graph.current?.flyToGroup(space.root)
              }}
              className={'flex min-w-0 flex-1 items-center gap-2 text-left hover:text-mist-100 ' + (space.shown ? 'text-mist-300' : 'text-mist-600')}
            >
              <span className={'h-2.5 w-2.5 shrink-0 rounded-full' + (space.shown ? '' : ' opacity-40')} style={{ background: space.color }} />
              <span className="flex-1 truncate">{space.name}</span>
            </button>
            {spaceRows.length > 1 && (
              <button
                type="button"
                onClick={() => chooseHidden(new Set(spaceRows.filter((row) => row.space !== space.space).map((row) => row.space)))}
                title={t('graph.onlySpaceTitle', { name: space.name })}
                aria-label={t('graph.onlySpaceTitle', { name: space.name })}
                className="hidden rounded px-1 text-[11px] text-mist-500 group-focus-within:inline group-hover:inline hover:text-accent-400 pointer-coarse:inline"
              >
                {t('graph.onlySpace')}
              </button>
            )}
            <span className="text-[11px] text-mist-600 tabular-nums group-focus-within:hidden group-hover:hidden pointer-coarse:hidden">{space.total}</span>
          </li>
        )
      })}
    </ul>
  )
  const spacesHead = (
    <div className="mb-2 flex items-center justify-between gap-2">
      <span className="text-[11px] font-semibold tracking-wider text-mist-600 uppercase">{t('graph.spaces')}</span>
      {hidden.size > 0 && (
        <button type="button" onClick={() => chooseHidden(new Set())} className="text-[11px] text-accent-400 hover:underline">
          {t('graph.allSpaces')}
        </button>
      )}
    </div>
  )

  return (
    <>
      <Sidebar activeNote={chosen?.path ?? null} activeFolder={null} onNote={(path) => void focusPath(path)} onFolder={flyToFolder} />
      <main className="relative min-w-0 flex-1 overflow-hidden">
        <h1 className="sr-only">{t('graph.heading')}</h1>
        <GraphView
          glow={me?.appearance?.graph_glow !== false}
          ref={graph}
          scene={scene}
          revision={revision}
          hideDaily={hideDaily}
          selected={chosen?.id ?? null}
          onSelect={select}
          onOpen={(id) => {
            const note = scene.notes.get(id)
            if (note) navigate(noteUrl(note.path))
          }}
          onCentre={setCentre}
          onHover={setHover}
          onView={data.onView}
          groupLabel={groupLabel}
          countLabel={countLabel}
          label={t('graph.canvas')}
        />

        {/* Breadcrumb: where on the map the middle of the screen is. */}
        <nav className="pointer-events-auto absolute top-3 left-3 flex max-w-[calc(100%-7.5rem)] flex-wrap items-center gap-1 rounded-full border border-ink-700 bg-ink-900/85 px-1.5 py-1 text-sm backdrop-blur sm:max-w-[calc(50%-10rem)]" aria-label={t('graph.position')}>
          <button type="button" onClick={() => graph.current?.fitAll()} className="rounded-full px-2.5 py-0.5 font-medium text-mist-400 hover:bg-ink-800 hover:text-mist-100">
            {t('graph.all')}
          </button>
          {crumbs.map((group) => (
            <span key={group.id} className="flex min-w-0 items-center gap-1">
              <Symbol name="chevronRight" className="h-3.5 w-3.5 shrink-0 text-mist-600" />
              <button type="button" onClick={() => graph.current?.flyToGroup(group.id)} className="flex min-w-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 font-medium text-mist-200 hover:bg-ink-800">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: group.color }} />
                <span className="truncate">{groupLabel(group)}</span>
              </button>
            </span>
          ))}
        </nav>

        <div className="absolute top-3 left-1/2 hidden -translate-x-1/2 sm:block">{cloudSwitch}</div>

        {/* Phone: cloud and filters in a sheet from below; with many spaces it scrolls in itself, its top stays on screen. */}
        <button
          type="button"
          onClick={() => setSheet(true)}
          className="absolute top-3 right-3 inline-flex items-center gap-1.5 rounded-full border border-ink-700 bg-ink-900/85 px-3 py-1 text-sm text-mist-300 backdrop-blur sm:hidden"
          aria-haspopup="dialog"
        >
          <Symbol name="graph" className="h-4 w-4" /> {t(`graph.cloud.${cloud}`)}
        </button>

        <div className="absolute top-3 right-3 hidden max-h-[calc(100%-11rem)] w-60 overflow-y-auto rounded-2xl border border-ink-700 bg-ink-900/85 p-3 text-sm backdrop-blur lg:block" data-testid="graph-filters">
          {spacesHead}
          {spaceList}
          <div className="mt-3 border-t border-ink-700 pt-3">{dailyToggle}</div>
          {cloudInfo && <div className="mt-3 border-t border-ink-700 pt-3">{cloudInfo}</div>}
        </div>

        {/* Zoom controls, above the spider of Lore when it sits in the corner. */}
        <div className="absolute right-3 bottom-[calc(0.75rem+var(--lore-corner,0px))] flex flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900/85 backdrop-blur">
          <button type="button" onClick={() => graph.current?.zoomBy(1.6)} className="p-2.5 text-mist-400 hover:bg-ink-800 hover:text-mist-100" title={t('graph.zoomIn')} aria-label={t('graph.zoomIn')}>
            <Symbol name="plus" />
          </button>
          <button type="button" onClick={() => graph.current?.zoomBy(1 / 1.6)} className="border-t border-ink-700 p-2.5 text-mist-400 hover:bg-ink-800 hover:text-mist-100" title={t('graph.zoomOut')} aria-label={t('graph.zoomOut')}>
            <Symbol name="minus" />
          </button>
          <button type="button" onClick={() => graph.current?.fitAll()} className="border-t border-ink-700 p-2.5 text-mist-400 hover:bg-ink-800 hover:text-mist-100" title={t('graph.fitAll')} aria-label={t('graph.fitAll')}>
            <Symbol name="fit" />
          </button>
        </div>

        {/* Hover label for groups and notes. */}
        {hover && (hoveredNote || hoveredGroup) && hover.id !== chosen?.id && (
          <div className="pointer-events-none absolute z-10 max-w-64 -translate-x-1/2 rounded-lg border border-ink-700 bg-ink-900/95 px-2.5 py-1.5 text-xs shadow-lg" style={{ left: hover.x, top: hover.y + 8 }}>
            {hoveredNote ? (
              <>
                <div className="truncate font-semibold text-mist-100">{hoveredNote.title}</div>
                <div className="text-mist-500">{t('graph.noteHover', { count: scene.neighbours(hoveredNote.id).size })}</div>
              </>
            ) : (
              <>
                <div className="truncate font-semibold text-mist-100">{groupLabel(hoveredGroup!)}</div>
                <div className="text-mist-500">{t('graph.folderHover', { count: hoveredGroup!.total })}</div>
              </>
            )}
          </div>
        )}

        {/* The chosen note. */}
        {chosen && (
          <div className="absolute bottom-3 left-3 w-[min(24rem,calc(100%-5rem))] rounded-2xl border border-ink-700 bg-ink-900/95 p-4 shadow-2xl backdrop-blur" data-testid="graph-card">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-mist-500">{folderOf(chosen.path).replace(/\//g, ' › ')}</div>
                <h2 className="mt-0.5 truncate text-lg font-semibold">{chosen.title}</h2>
              </div>
              <button type="button" onClick={() => setChosen(null)} className="rounded-md p-1 text-mist-500 hover:bg-ink-800 hover:text-mist-100" aria-label={t('common.close')}>
                <Symbol name="close" />
              </button>
            </div>
            {links && (
              <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                <span className="rounded-full bg-ink-800 px-2 py-0.5 text-mist-400">{t('graph.links', { count: links.outgoing.filter((link) => link.path).length })}</span>
                <span className="rounded-full bg-ink-800 px-2 py-0.5 text-mist-400">{t('graph.backlinks', { count: links.backlinks.length })}</span>
              </div>
            )}
            {links && links.backlinks.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm">
                {links.backlinks.slice(0, 3).map((back) => (
                  <li key={back.path + back.line} className="truncate text-mist-400">
                    <button type="button" onClick={() => void focusPath(back.path, back.title)} className="font-medium text-mist-200 hover:text-accent-400">
                      {back.title}
                    </button>
                    <span className="text-mist-600"> · {folderOf(back.path).replace(/\//g, ' › ')}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => navigate(noteUrl(chosen.path))} className="inline-flex items-center gap-2 rounded-full bg-accent-500 px-4 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-400">
                <Symbol name="open" /> {t('graph.open')}
              </button>
              <button type="button" onClick={() => void focusPath(chosen.path, chosen.title)} className="rounded-full border border-ink-700 px-3.5 py-1.5 text-sm text-mist-300 hover:bg-ink-800">
                {t('graph.flyToNote')}
              </button>
            </div>
          </div>
        )}

        {data.building.length > 0 && (
          <div className="absolute inset-x-0 top-16 flex justify-center px-4" role="status">
            <p className="rounded-full border border-ink-700 bg-ink-900/90 px-4 py-1.5 text-sm text-mist-300">
              {t('graph.building', { spaces: data.building.join(', ') })}
            </p>
          </div>
        )}

        {status === 'ready' && data.building.length === 0 && hidden.size === 0 && Object.keys(overviews).length === spaces.length && total === 0 && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="flex max-w-md flex-col items-center gap-3 rounded-2xl border border-ink-700 bg-ink-900/90 px-5 py-4 text-center text-sm text-mist-400" data-testid="graph-empty">
              {scan.running ? (
                <p>{t('scan.graphEmpty')}</p>
              ) : (
                <>
                  {/* The first step said, with a button for it (P1.18): a space first, then a note. */}
                  <p>{spaces.length === 0 ? t('graph.empty') : t('graph.emptyMember')}</p>
                  {spaces.length === 0 ? (
                    <button type="button" onClick={() => askVaultAction({ kind: 'new-space' })} className={FIRST_STEP}>
                      <Symbol name="plus" /> {t('sidebar.newSpace')}
                    </button>
                  ) : (
                    home && (
                      <button type="button" onClick={() => askNewNote(home.name)} className={FIRST_STEP}>
                        <Symbol name="plus" /> {t('sidebar.newNote')}
                      </button>
                    )
                  )}
                  {me?.role === 'operator' && spaces.length === 0 && <p className="text-xs text-mist-500">{t('graph.importHint')}</p>}
                </>
              )}
            </div>
          </div>
        )}

        {/* First hint. */}
        {hintOpen && !chosen && total > 0 && (
          <div className="absolute bottom-3 left-1/2 hidden -translate-x-1/2 items-center gap-3 rounded-full border border-ink-700 bg-ink-900/90 py-1.5 pr-1.5 pl-4 text-xs text-mist-400 backdrop-blur md:flex">
            <span>{t('graph.hint')}</span>
            <button type="button" onClick={() => setHintOpen(false)} className="rounded-full p-1 hover:bg-ink-800 hover:text-mist-100" aria-label={t('graph.closeHint')}>
              <Symbol name="close" className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {sheet && (
          <div className="absolute inset-0 z-20 flex items-end bg-scrim/60 sm:hidden" onClick={() => setSheet(false)}>
            <div className="max-h-[85%] w-full overflow-y-auto rounded-t-2xl border-t border-ink-700 bg-ink-900 p-4 text-sm" onClick={(event) => event.stopPropagation()} role="dialog" aria-label={t('graph.clouds')}>
              <div className="mb-2 flex items-start">
                <div className="mx-auto h-1 w-10 rounded-full bg-ink-700" />
                <button type="button" onClick={() => setSheet(false)} aria-label={t('common.close')} className="-mt-1 -mr-1 rounded-full p-1.5 text-mist-500 hover:bg-ink-850 hover:text-mist-100">
                  <Symbol name="close" className="h-4 w-4" />
                </button>
              </div>
              <div className="mb-2 text-[11px] font-semibold tracking-wider text-mist-600 uppercase">{t('graph.clouds')}</div>
              {cloudSwitch}
              {cloudInfo && <div className="mt-3">{cloudInfo}</div>}
              <div className="mt-4">{spacesHead}</div>
              {spaceList}
              <div className="mt-4 border-t border-ink-700 pt-3">{dailyToggle}</div>
            </div>
          </div>
        )}
      </main>
    </>
  )
}
