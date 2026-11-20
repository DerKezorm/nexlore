/**
 * What the drawing surface decides without a browser: the tools and how their buttons and keys work, a new stroke,
 * the eraser's size, and the steps back and forth.
 */
import { INK, LIMITS, MARKER_COLOR, clamp, type InkBackground, type InkPoint, type InkStroke } from '../lib/ink'

export type ToolName = 'pen' | 'marker' | 'eraser' | 'lasso'
/** The eraser takes whole strokes (as it starts, D4) or only what it passes over. */
export type EraserMode = 'stroke' | 'part'
export type Tools = { tool: ToolName; color: string; size: number; eraser: EraserMode }

export const START_TOOLS: Tools = { tool: 'pen', color: INK, size: 4, eraser: 'stroke' }

/**
 * A tool's button pressed. The eraser pressed while it is chosen asks which kind (D4: a second click); any other
 * button chooses its tool.
 */
export function pressTool(tools: Tools, tool: ToolName): { tools: Tools; askEraser: boolean } {
  if (tool === 'eraser' && tools.tool === 'eraser') return { tools, askEraser: true }
  return { tools: { ...tools, tool }, askEraser: false }
}

/** A colour chosen: it is for drawing, so the eraser or the lasso give way to the pen. */
export function pickColor(tools: Tools, color: string): Tools {
  return { ...tools, color, tool: tools.tool === 'pen' || tools.tool === 'marker' ? tools.tool : 'pen' }
}

/** A stroke begun at `start` with the tools as they are: a highlighter in ink is yellow, and never thin. */
export function newStroke(tools: Tools, start: InkPoint): InkStroke {
  const marker = tools.tool === 'marker'
  return {
    tool: marker ? 'marker' : 'pen',
    color: marker && tools.color === INK ? MARKER_COLOR : tools.color,
    size: marker ? Math.max(4, tools.size) : tools.size,
    pts: [start],
  }
}

/** The eraser's radius in drawing units at `z` pixels per unit: the same size on the screen at any zoom. */
export function eraserRadius(tools: Tools, z: number): number {
  return (tools.eraser === 'stroke' ? 7 : 5 + tools.size * 2) / z
}

// --- Keys ----------------------------------------------------------------------------------------------------------------

export type InkAction =
  | { tool: ToolName }
  | { act: 'undo' | 'redo' | 'delete' | 'escape' | 'showAll' }

type Key = { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }

const TOOL_KEYS: Record<string, ToolName> = { p: 'pen', m: 'marker', e: 'eraser', l: 'lasso' }

/**
 * What a key does while drawing: P, M, E, L choose a tool; Ctrl (Cmd) Z steps back, with Shift (or Ctrl Y) forth;
 * Delete takes the chosen strokes away; Escape lets go; Shift 1 shows everything. Null for any other key.
 */
export function inkKey(event: Key): InkAction | null {
  const command = event.ctrlKey || event.metaKey
  const key = event.key.toLowerCase()
  if (command && !event.altKey && key === 'z') return { act: event.shiftKey ? 'redo' : 'undo' }
  if (command && !event.altKey && !event.shiftKey && key === 'y') return { act: 'redo' }
  if (command || event.altKey) return null
  if (event.key === 'Delete' || event.key === 'Backspace') return { act: 'delete' }
  if (event.key === 'Escape') return { act: 'escape' }
  if (event.shiftKey && (event.code === 'Digit1' || event.key === '!')) return { act: 'showAll' }
  if (!event.shiftKey && key in TOOL_KEYS) return { tool: TOOL_KEYS[key] }
  return null
}

// --- Steps back and forth --------------------------------------------------------------------------------------------------

/** What a step changes: the strokes and the paper. The view is not a step. */
export type Snapshot = { strokes: InkStroke[]; bg: InkBackground }
export type History = { past: Snapshot[]; future: Snapshot[] }

/** How many steps back are kept. */
export const STEPS = 100
export const NO_HISTORY: History = { past: [], future: [] }

/** A change made: what was before is a step back, the steps forth are gone. */
export function recorded(history: History, before: Snapshot): History {
  return { past: [...history.past, before].slice(-STEPS), future: [] }
}

/** One step back from `present`; null when there is none. */
export function stepBack(history: History, present: Snapshot): { history: History; present: Snapshot } | null {
  const back = history.past.at(-1)
  if (!back) return null
  return { history: { past: history.past.slice(0, -1), future: [present, ...history.future] }, present: back }
}

/** One step forth from `present`; null when there is none. */
export function stepForth(history: History, present: Snapshot): { history: History; present: Snapshot } | null {
  const forth = history.future[0]
  if (!forth) return null
  return { history: { past: [...history.past, present].slice(-STEPS), future: history.future.slice(1) }, present: forth }
}

// --- Sizes of a block -------------------------------------------------------------------------------------------------------

/** A block's height dragged by `dy` pixels from `start`, within what the file keeps. */
export function draggedHeight(start: number, dy: number): number {
  return Math.round(clamp(start + dy, LIMITS.minHeight, LIMITS.maxHeight))
}
