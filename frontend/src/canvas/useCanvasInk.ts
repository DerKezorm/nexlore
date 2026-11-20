/**
 * The pen's layer of a canvas as the canvas holds it (`inkLayer.ts`): the drawing loaded and saved like any drawing
 * (`ink/useInk.ts`, its own lock and steps back), made with the first stroke (`POST /api/inks {canvas}`, then its card
 * goes onto the canvas), and its card's box kept on the strokes' box. Neither the card nor its box is a step of the
 * canvas's own: going back on the canvas never takes the drawing away.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ApiError, inkApi } from '../api/client'
import { moveStrokes, type InkBackground, type InkStroke } from '../lib/ink'
import { useInk, type InkController } from '../ink/useInk'
import { writtenPath } from './context'
import { carriedStrokes, hiddenStrokes, inkLayerOf, layerBox, makeLayer, sameBox } from './inkLayer'
import { addNode, updateNodes, type Canvas, type CanvasNode } from './model'

type Box = { x: number; y: number; width: number; height: number }
const NONE: readonly Box[] = []

type Args = {
  /** The canvas's path and space. */
  path: string
  space: string
  /** The layer's card on the canvas as it is now, if there is one. */
  layer: CanvasNode | undefined
  /** Where a card's path leads (`CanvasCards.target`). */
  target: (written: string) => { path: string; locked: boolean }
  remember: (written: string, path: string) => void
  /** Whether the canvas may be changed now. */
  editable: boolean
  adjust: (change: (canvas: Canvas) => Canvas) => void
  /** Where folded PDF cards hide their pages: strokes lying wholly there are neither shown nor touched. */
  hidden?: readonly Box[]
}

/** Strokes that went along with moved cards: as they were, and as they are now (same order). */
export type CarriedStrokes = { before: InkStroke[]; after: InkStroke[] }

export type CanvasInk = {
  /** The drawing as the surface and the toolbar work with it. */
  ink: InkController
  /** The strokes lying wholly on cards that moved by (`dx`, `dy`) go along, as one change of the drawing; which. */
  carry: (boxes: Box[], dx: number, dy: number) => CarriedStrokes | null
  /** Strokes as `from` turned into `to`, wherever they still are (a step back on the canvas takes them along). */
  swap: (from: InkStroke[], to: InkStroke[]) => void
  /** Why the layer could not be made, if it could not. */
  failed: string | null
}

export function useCanvasInk({ path, space, layer, target, remember, editable, adjust, hidden = NONE }: Args): CanvasInk {
  const found = layer?.file ? target(layer.file) : null
  // The layer's file gone from the disk: the next stroke makes a new one, and the card leads there.
  const [lost, setLost] = useState<string | null>(null)
  const inkPath = found && !found.locked && found.path !== lost ? found.path : null
  const ink = useInk(inkPath, space)
  useEffect(() => {
    if (inkPath && ink.status === 'failed' && ink.error === 'not_found') setLost(inkPath)
  }, [inkPath, ink.status, ink.error])

  // The first strokes, shown while their file is being made, and committed once it is loaded.
  const [pending, setPending] = useState<InkStroke[] | null>(null)
  const pendingRef = useRef<InkStroke[] | null>(null)
  const making = useRef(false)
  const [failed, setFailed] = useState<string | null>(null)
  const ready = inkPath !== null && ink.status === 'ready' && ink.source === inkPath && !!ink.loaded

  const { commit: commitInk } = ink
  const commit = useCallback(
    (strokes: InkStroke[], bg?: InkBackground) => {
      if (inkPath) return commitInk(strokes, bg)
      if (!editable || found?.locked) return
      pendingRef.current = strokes
      setPending(strokes)
      if (making.current) return
      making.current = true
      setFailed(null)
      inkApi
        .createLayer(path)
        .then((made) => {
          const written = writtenPath(space, made.path)
          remember(written, made.path)
          const first = pendingRef.current ?? []
          adjust((canvas) => {
            const there = inkLayerOf(canvas)
            // A card whose file was gone leads to the new one; else the card goes on top of every other.
            return there ? updateNodes(canvas, { [there.id]: { file: written, ...layerBox(first) } }) : addNode(canvas, makeLayer(canvas, written, first))
          })
          setLost(null)
        })
        .catch((caught: unknown) => {
          pendingRef.current = null
          setPending(null)
          setFailed(caught instanceof ApiError ? caught.code : 'internal_error')
        })
        .finally(() => {
          making.current = false
        })
    },
    [inkPath, commitInk, editable, found?.locked, path, space, remember, adjust],
  )

  // The file is made and loaded: the strokes drawn meanwhile are its first change.
  useEffect(() => {
    if (!ready || !pendingRef.current) return
    const first = pendingRef.current
    pendingRef.current = null
    setPending(null)
    commitInk(first)
  }, [ready, commitInk])

  // The card's box follows the strokes: after each stroke, a step back, a move, a change from elsewhere.
  const strokes = ink.strokes
  useEffect(() => {
    if (!layer || !ready || !editable || pending) return
    const box = layerBox(strokes)
    if (!sameBox(layer, box)) adjust((canvas) => updateNodes(canvas, { [layer.id]: box }))
  }, [layer, ready, editable, pending, strokes, adjust])

  const carry = useCallback(
    (boxes: Box[], dx: number, dy: number): CarriedStrokes | null => {
      if (!ready || ink.readonly || (!dx && !dy)) return null
      const picked = carriedStrokes(ink.strokes, boxes)
      if (!picked.length) return null
      const next = moveStrokes(ink.strokes, picked, dx, dy)
      commitInk(next)
      return { before: picked.map((index) => ink.strokes[index]), after: picked.map((index) => next[index]) }
    },
    [ready, ink.readonly, ink.strokes, commitInk],
  )

  // Found by what they are, not by their place or the object: the drawing may have changed or been loaded again since.
  const swap = useCallback(
    (from: InkStroke[], to: InkStroke[]) => {
      if (!ready || ink.readonly || !from.length) return
      const wanted = new Map<string, number[]>()
      from.forEach((stroke, index) => {
        const key = JSON.stringify(stroke)
        wanted.set(key, [...(wanted.get(key) ?? []), index])
      })
      let changed = false
      const next = ink.strokes.map((stroke) => {
        const found = wanted.get(JSON.stringify(stroke))
        if (!found?.length) return stroke
        changed = true
        return to[found.shift()!]
      })
      if (changed) commitInk(next)
    },
    [ready, ink.readonly, ink.strokes, commitInk],
  )

  // Strokes under folded PDF pages: out of the surface's sight, and kept as they are whatever it commits.
  const out = useMemo(() => {
    const places = new Set(hidden.length ? hiddenStrokes(ink.strokes, hidden) : [])
    return { strokes: ink.strokes.filter((_, index) => !places.has(index)), kept: ink.strokes.filter((_, index) => places.has(index)) }
  }, [ink.strokes, hidden])
  const commitShown = useCallback(
    (strokes: InkStroke[], bg?: InkBackground) => commit(out.kept.length ? [...strokes, ...out.kept] : strokes, bg),
    [commit, out.kept],
  )

  const shown = useMemo<InkController>(
    () => ({
      ...ink,
      strokes: pending ?? out.strokes,
      commit: commitShown,
      // Drawn only where the canvas may be changed, and never into a layer in a space whoever looks may not read.
      readonly: !editable || !!found?.locked || (inkPath ? ink.readonly : false),
    }),
    [ink, pending, out.strokes, commitShown, editable, found?.locked, inkPath],
  )
  return { ink: shown, carry, swap, failed }
}
