/**
 * Nested layout for the zoomable graph.
 *
 * Each folder is laid out on its own, from the bottom up: its notes and subfolders are placed with a small force
 * simulation, then the folder becomes a circle around them. The parent then only moves whole circles. That keeps
 * every folder a closed region on the map, which is what makes zooming from "countries" to "cities" possible.
 * Links between two items of the same folder pull them together, so related subfolders end up side by side.
 */
import { forceCollide, forceLink, forceSimulation, forceX, forceY, type SimulationNodeDatum } from 'd3-force'

import type { Cluster, Vault } from '../lib/vault'

export type Placed = { x: number; y: number; r: number }

export type Layout = {
  notes: Map<string, Placed>
  clusters: Map<string, Placed>
}

type Item = SimulationNodeDatum & { key: string; r: number }

/** Dot size of a note grows slowly with its number of links. */
export function noteRadius(degree: number): number {
  return 5 + Math.min(7, Math.sqrt(degree) * 1.6)
}

export function computeLayout(vault: Vault): Layout {
  const degree = new Map<string, number>()
  for (const { from, to } of vault.links) {
    degree.set(from, (degree.get(from) ?? 0) + 1)
    degree.set(to, (degree.get(to) ?? 0) + 1)
  }

  // Which child of a folder contains a note: the note itself or one of the subfolders.
  const childOf = (cluster: Cluster, noteId: string): string | null => {
    let c = vault.home.get(noteId) ?? null
    if (c === cluster) return 'n:' + noteId
    while (c && c.parent !== cluster) c = c.parent
    return c ? 'c:' + c.id : null
  }

  // Relative positions, filled from the bottom up.
  const relative = new Map<string, { x: number; y: number }>()
  const radius = new Map<string, number>()

  const place = (cluster: Cluster): number => {
    const items: Item[] = []
    for (const child of cluster.children) items.push({ key: 'c:' + child.id, r: place(child) })
    for (const note of cluster.notes) items.push({ key: 'n:' + note.id, r: noteRadius(degree.get(note.id) ?? 0) + 12 })

    const index = new Map(items.map((item, i) => [item.key, i]))
    const weights = new Map<string, number>()
    for (const { from, to } of vault.links) {
      const a = childOf(cluster, from)
      const b = childOf(cluster, to)
      if (!a || !b || a === b) continue
      const key = a < b ? a + '>' + b : b + '>' + a
      weights.set(key, (weights.get(key) ?? 0) + 1)
    }
    const edges = [...weights].map(([key, weight]) => {
      const [a, b] = key.split('>')
      return { source: index.get(a)!, target: index.get(b)!, weight }
    })

    const gap = cluster.depth <= 1 ? 40 : 16
    const simulation = forceSimulation(items)
      .force('collide', forceCollide<Item>((d) => d.r + gap / 2).iterations(3))
      .force(
        'link',
        forceLink<Item, { source: number; target: number; weight: number }>(edges)
          .distance((e) => (e.source as unknown as Item).r + (e.target as unknown as Item).r + gap)
          .strength((e) => Math.min(0.5, 0.08 * e.weight)),
      )
      .force('x', forceX(0).strength(0.06))
      .force('y', forceY(0).strength(0.06))
      .stop()
    for (let i = 0; i < 320; i++) simulation.tick()

    // Center on the middle of the extent, then take the enclosing circle.
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const item of items) {
      minX = Math.min(minX, item.x! - item.r)
      maxX = Math.max(maxX, item.x! + item.r)
      minY = Math.min(minY, item.y! - item.r)
      maxY = Math.max(maxY, item.y! + item.r)
    }
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    let extent = 0
    for (const item of items) {
      item.x! -= cx
      item.y! -= cy
      extent = Math.max(extent, Math.hypot(item.x!, item.y!) + item.r)
      relative.set(item.key, { x: item.x!, y: item.y! })
    }
    const r = extent + (cluster.depth <= 1 ? 30 : 16)
    radius.set(cluster.id, r)
    return r
  }

  place(vault.root)

  // From the top down: absolute positions.
  const layout: Layout = { notes: new Map(), clusters: new Map() }
  const assign = (cluster: Cluster, x: number, y: number) => {
    layout.clusters.set(cluster.id, { x, y, r: radius.get(cluster.id)! })
    for (const child of cluster.children) {
      const p = relative.get('c:' + child.id)!
      assign(child, x + p.x, y + p.y)
    }
    for (const note of cluster.notes) {
      const p = relative.get('n:' + note.id)!
      layout.notes.set(note.id, { x: x + p.x, y: y + p.y, r: noteRadius(degree.get(note.id) ?? 0) })
    }
  }
  assign(vault.root, 0, 0)
  return layout
}
