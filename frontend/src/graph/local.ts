/** Layout of the local graph on a note's page: a small force simulation, the note fixed in the middle. */
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationNodeDatum } from 'd3-force'

import type { LocalNode } from '../api/client'

export type Dot = SimulationNodeDatum & { id: number; path: string; title: string; depth: number }

/** Positions for the dots: the note fixed in the middle, the others pushed apart and pulled along their links. */
export function layoutLocal(nodes: LocalNode[], links: [number, number][]): Dot[] {
  const dots: Dot[] = nodes.map(([id, path, title, depth], index) => {
    const angle = index * 2.399963
    const distance = depth * 40
    return { id, path, title, depth, x: Math.cos(angle) * distance, y: Math.sin(angle) * distance, ...(depth === 0 ? { fx: 0, fy: 0 } : {}) }
  })
  const known = new Set(dots.map((dot) => dot.id))
  const edges = links.filter(([a, b]) => known.has(a) && known.has(b)).map(([source, target]) => ({ source, target }))
  const simulation = forceSimulation(dots)
    .force('link', forceLink<Dot, { source: number; target: number }>(edges).id((dot) => dot.id).distance(46).strength(0.6))
    .force('charge', forceManyBody().strength(-140))
    .force('collide', forceCollide(16))
    .force('center', forceCenter(0, 0).strength(0.05))
    .stop()
  for (let i = 0; i < 300; i++) simulation.tick()
  return dots
}
