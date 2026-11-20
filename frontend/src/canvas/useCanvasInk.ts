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
import { carriedStrokes, inkLayerOf, layerBox, makeLayer, sameBox } from './inkLayer'
import { addNode, updateNodes, type Canvas, type CanvasNode } from './model'

type Box = { x: number; y: number; width: number; height: number }

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
}

export type CanvasInk = {
  /** The drawing as the surface and the toolbar work with it. */
  ink: InkController
  /** The strokes lying wholly on cards that moved by (`dx`, `dy`) go along, as one change of the drawing. */
  carry: (boxes: Box[], dx: number, dy: number) => void
  /** Why the layer could not be made, if it could not. */
  failed: string | null
}

export function useCanvasInk({ path, space, layer, target, remember, editable, adjust }: Args): CanvasInk {
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
    (boxes: Box[], dx: number, dy: number) => {
      if (!ready || ink.readonly || (!dx && !dy)) return
      const picked = carriedStrokes(ink.strokes, boxes)
      if (picked.length) commitInk(moveStrokes(ink.strokes, picked, dx, dy))
    },
    [ready, ink.readonly, ink.strokes, commitInk],
  )

  const shown = useMemo<InkController>(
    () => ({
      ...ink,
      strokes: pending ?? ink.strokes,
      commit,
      // Drawn only where the canvas may be changed, and never into a layer in a space whoever looks may not read.
      readonly: !editable || !!found?.locked || (inkPath ? ink.readonly : false),
    }),
    [ink, pending, commit, editable, found?.locked, inkPath],
  )
  return { ink: shown, carry, failed }
}
