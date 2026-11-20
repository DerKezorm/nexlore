/**
 * Drawing strokes and paper into an SVG, always from the strokes (never from a file's SVG text). Ink is
 * `currentColor`: the surface sets the theme's text colour, so ink follows light and dark.
 */
import { memo, useId } from 'react'

import { INK, MARKER_OPACITY, bounds, strokeShape, type Box, type InkBackground, type InkStroke } from '../lib/ink'

/** One stroke; drawn again only when it is another stroke (strokes are never changed in place once drawn). */
export const StrokePath = memo(function StrokePath({ stroke, dim }: { stroke: InkStroke; dim?: boolean }) {
  const shape = strokeShape(stroke)
  const ink = stroke.color === INK
  const color = ink ? 'currentColor' : stroke.color
  // Ink is marked: over a canvas in the dark it is drawn in a layer of its own that turns it dark on light cards.
  const mark = ink ? '' : undefined
  if (!shape.d) return null
  return shape.filled ? (
    <path d={shape.d} fill={color} opacity={dim ? 0.55 : undefined} data-ink={mark} />
  ) : (
    <path
      d={shape.d}
      data-ink={mark}
      fill="none"
      stroke={color}
      strokeWidth={shape.width}
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity={dim ? MARKER_OPACITY * 0.6 : MARKER_OPACITY}
    />
  )
})

export const Strokes = memo(function Strokes({ strokes, picked }: { strokes: InkStroke[]; picked?: readonly number[] }) {
  const dimmed = new Set(picked ?? [])
  return (
    <g data-strokes={strokes.length}>
      {strokes.map((stroke, index) => (
        <StrokePath key={index} stroke={stroke} dim={dimmed.has(index)} />
      ))}
    </g>
  )
})

const LINE = { stroke: 'var(--color-ink-700)', vectorEffect: 'non-scaling-stroke' as const }

/** The paper's pattern, endless: lines, squares or dots in drawing units, laid over `box`. */
export function Paper({ bg, box }: { bg: InkBackground; box: Box }) {
  const id = 'nl-paper-' + useId().replace(/[^a-zA-Z0-9_-]/g, '')
  if (bg === 'none') return null
  const size = bg === 'lines' ? 32 : bg === 'grid' ? 24 : 22
  return (
    <>
      <defs>
        <pattern id={id} width={size} height={size} patternUnits="userSpaceOnUse">
          {bg === 'lines' && <line x1={0} x2={size} y1={size - 0.5} y2={size - 0.5} style={LINE} />}
          {bg === 'grid' && <path d={`M0 ${size - 0.5}H${size}M${size - 0.5} 0V${size}`} fill="none" style={LINE} />}
          {bg === 'dots' && <circle cx={size / 2} cy={size / 2} r={1.2} style={{ fill: 'var(--color-ink-700)' }} />}
        </pattern>
      </defs>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} fill={`url(#${id})`} pointerEvents="none" data-paper={bg} />
    </>
  )
}

/**
 * The whole drawing as a picture that fills its box (a card on a canvas): nothing to touch, the paper as far as the
 * strokes go.
 */
export function InkPicture({ strokes, bg, className = '' }: { strokes: InkStroke[]; bg: InkBackground; className?: string }) {
  const box = bounds(strokes)
  return (
    <svg
      viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
      preserveAspectRatio="xMidYMid meet"
      className={'block h-full w-full text-mist-100 select-none ' + className}
      style={{ pointerEvents: 'none' }}
      data-ink-picture=""
    >
      <Paper bg={bg} box={box} />
      <Strokes strokes={strokes} />
    </svg>
  )
}
