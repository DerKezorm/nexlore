/**
 * Loads the graph for the page: the overview of every space (all circles, link counts between groups), then the
 * tiles for what is on screen, as the camera moves. At most two tile requests run at a time; what the camera left
 * behind before its request went out is not asked for. While a big space is still being laid out on the server, its
 * overview is asked for again every two seconds; after that every thirty, to notice changes made elsewhere.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { graphApi, type Cloud, type Overview, type Space } from '../api/client'
import type { Camera } from './gl'
import { Scene } from './scene'

const BATCH = 48
const PARALLEL = 2
const SETTLE_MS = 120
const BUILDING_POLL_MS = 2000
const READY_POLL_MS = 30_000
/** A tile whose request failed is not asked for again before this. */
const RETRY_MS = 10_000

export type GraphData = {
  scene: Scene
  revision: number
  overviews: Record<string, Overview>
  /** Spaces whose map the server is still working out. */
  building: string[]
  failed: boolean
  onView: (camera: Camera, width: number, height: number) => void
  refresh: () => void
}

export function useGraph(spaces: Space[], cloud: Cloud, generation: number): GraphData {
  // A new scene for every cloud: the same notes stand elsewhere in each.
  const scene = useMemo(() => new Scene(), [cloud]) // eslint-disable-line react-hooks/exhaustive-deps
  const [revision, setRevision] = useState(0)
  const [overviews, setOverviews] = useState<Record<string, Overview>>({})
  const [failed, setFailed] = useState(false)
  const [nudge, setNudge] = useState(0)
  const view = useRef<{ camera: Camera; width: number; height: number } | null>(null)
  const pending = useRef(new Set<string>())
  const failedAt = useRef(new Map<string, number>())
  const running = useRef(0)
  const timer = useRef(0)
  const tileSize = useRef(512)
  const again = useRef<() => void>(() => undefined)
  const names = spaces.map((space) => space.name).join('\n')

  useEffect(() => {
    let alive = true
    let poll = 0
    const load = async () => {
      try {
        const list = await Promise.all(
          names
            .split('\n')
            .filter(Boolean)
            .map(async (name) => ({ name, overview: await graphApi.overview(name, cloud) })),
        )
        if (!alive) return
        const ready = list.filter((item) => item.overview.status === 'ready')
        scene.setOverviews(ready)
        if (ready.length) tileSize.current = ready[0].overview.tile
        setOverviews(Object.fromEntries(list.map((item) => [item.name, item.overview])))
        setFailed(false)
        setRevision((value) => value + 1)
        const busy = list.some((item) => item.overview.status === 'building' || item.overview.working)
        poll = window.setTimeout(load, busy ? BUILDING_POLL_MS : READY_POLL_MS)
      } catch {
        if (!alive) return
        setFailed(true)
        poll = window.setTimeout(load, BUILDING_POLL_MS * 5)
      }
    }
    void load()
    return () => {
      alive = false
      window.clearTimeout(poll)
    }
  }, [scene, cloud, names, generation, nudge])

  const fetchTiles = useCallback(() => {
    const current = view.current
    if (!current) return
    const wanted = scene.wanted(current.camera, current.width, current.height, tileSize.current)
    const all: string[] = []
    for (const list of wanted.values()) for (const item of list) all.push(item.key)
    scene.touch(all)
    for (const [space, list] of wanted) {
      const now = Date.now()
      const missing = list.filter(
        (item) => !scene.tiles.has(item.key) && !pending.current.has(item.key) && now - (failedAt.current.get(item.key) ?? 0) > RETRY_MS,
      )
      for (let start = 0; start < missing.length && running.current < PARALLEL; start += BATCH) {
        const part = missing.slice(start, start + BATCH)
        for (const item of part) pending.current.add(item.key)
        running.current++
        graphApi
          .tiles(space, cloud, part.map((item) => item.tile))
          .then((data) => {
            scene.addTiles(space, part.map((item) => item.key), data)
            setRevision((value) => value + 1)
          })
          .catch(() => {
            for (const item of part) failedAt.current.set(item.key, Date.now())
          })
          .finally(() => {
            for (const item of part) pending.current.delete(item.key)
            running.current--
            // More may be waiting for a free slot.
            window.clearTimeout(timer.current)
            timer.current = window.setTimeout(() => again.current(), 0)
          })
      }
    }
  }, [scene, cloud])

  useEffect(() => {
    again.current = fetchTiles
  }, [fetchTiles])

  // New overviews (and their versions) can make other tiles necessary.
  useEffect(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(fetchTiles, 0)
  }, [revision, fetchTiles])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const onView = useCallback(
    (camera: Camera, width: number, height: number) => {
      const before = view.current
      view.current = { camera: { ...camera }, width, height }
      if (before && before.camera.x === camera.x && before.camera.y === camera.y && before.camera.k === camera.k) return
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(fetchTiles, SETTLE_MS)
    },
    [fetchTiles],
  )

  const building = Object.entries(overviews)
    .filter(([, overview]) => overview.status === 'building')
    .map(([name]) => name)

  const refresh = useCallback(() => setNudge((value) => value + 1), [])

  return { scene, revision, overviews, building, failed, onView, refresh }
}
