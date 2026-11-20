/**
 * The pen's toolbar: pen, highlighter, eraser (pressed again: whole strokes or only what it passes, D4), lasso;
 * colours, sizes, the paper; back and forth; the chosen strokes away; and "Done" where drawing ends (a block).
 * Its buttons never take the focus from the surface: the keys keep working.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Symbol, type SymbolName } from '../components/Symbol'
import { BACKGROUNDS, COLORS, INK, SIZES, removeStrokes, type InkBackground } from '../lib/ink'
import { pickColor, pressTool, type EraserMode, type ToolName, type Tools } from './logic'
import type { InkController } from './useInk'

type Props = {
  ink: InkController
  tools: Tools
  setTools: (next: Tools) => void
  /** Ends drawing (a block in a note); without it there is no such button. */
  onDone?: () => void
  /** Its menus open upwards (a toolbar docked at the bottom). */
  up?: boolean
  /** The paper's menu; not over a canvas, whose cards the paper would cover. */
  paper?: boolean
  className?: string
}

const TOOL_SYMBOL: Record<ToolName, SymbolName> = { pen: 'pencil', marker: 'marker', eraser: 'eraser', lasso: 'lasso' }

export function InkToolbar({ ink, tools, setTools, onDone, up = false, paper: withPaper = true, className = '' }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState<'eraser' | 'paper' | null>(null)
  const bar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => {
      if (!bar.current?.contains(event.target as Node)) setOpen(null)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  const writable = !ink.readonly
  const key = { pen: 'P', marker: 'M', eraser: 'E', lasso: 'L' }
  const toolLabel = (tool: ToolName) => `${t(`ink.tool.${tool}`)} (${key[tool]})`

  const button = (id: string, label: string, content: ReactNode, onClick: () => void, options: { pressed?: boolean; disabled?: boolean; wide?: boolean } = {}) => (
    <button
      key={id}
      type="button"
      data-ink-tool={id}
      aria-label={label}
      title={label}
      aria-pressed={options.pressed}
      disabled={options.disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={
        'relative inline-flex h-8 shrink-0 items-center justify-center rounded-lg text-mist-300 hover:bg-ink-800 hover:text-mist-100 disabled:opacity-35 disabled:hover:bg-transparent ' +
        (options.wide ? 'px-2.5 text-xs font-semibold ' : 'w-8 ') +
        (options.pressed ? 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/20 hover:text-accent-300' : '')
      }
    >
      {content}
    </button>
  )
  const gap = (id: string) => <span key={id} aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-ink-700" />
  const menu = (items: { id: string; label: string; on: boolean; pick: () => void }[]) => (
    <div role="menu" className={'absolute left-0 z-30 flex ' + (up ? 'bottom-full mb-1.5 ' : 'top-full mt-1.5 ') + 'min-w-44 flex-col rounded-xl border border-ink-700 bg-ink-850 p-1 shadow-xl'}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitemradio"
          aria-checked={item.on}
          data-ink-choice={item.id}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            item.pick()
            setOpen(null)
          }}
          className={'rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-ink-800 ' + (item.on ? 'text-accent-400' : 'text-mist-300')}
        >
          {item.label}
        </button>
      ))}
    </div>
  )

  const choose = (tool: ToolName) => {
    const pressed = pressTool(tools, tool)
    setTools(pressed.tools)
    if (pressed.askEraser) setOpen(open === 'eraser' ? null : 'eraser')
    else setOpen(null)
    if (tool !== 'lasso') ink.select([])
  }
  const eraserMode = (mode: EraserMode) => setTools({ ...tools, tool: 'eraser', eraser: mode })
  const paper = (bg: InkBackground) => ink.commit(ink.strokes, bg)

  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label={t('ink.toolbar')}
      data-testid="ink-toolbar"
      className={'relative z-20 flex flex-wrap items-center gap-0.5 rounded-xl border border-ink-700 bg-ink-900/95 px-1.5 py-1 shadow-lg backdrop-blur ' + className}
    >
      {(['pen', 'marker'] as const).map((tool) => button(tool, toolLabel(tool), <Symbol name={TOOL_SYMBOL[tool]} className="h-4 w-4" />, () => choose(tool), { pressed: tools.tool === tool, disabled: !writable }))}
      <span className="relative">
        {button(
          'eraser',
          `${toolLabel('eraser')}, ${t('ink.eraserAgain')}`,
          <>
            <Symbol name="eraser" className="h-4 w-4" />
            <span className="absolute right-0.5 bottom-0 text-[9px] leading-none font-semibold text-mist-500" data-eraser-mode={tools.eraser}>
              {tools.eraser === 'stroke' ? t('ink.eraserStrokeShort') : t('ink.eraserPartShort')}
            </span>
          </>,
          () => choose('eraser'),
          { pressed: tools.tool === 'eraser', disabled: !writable },
        )}
        {open === 'eraser' &&
          menu([
            { id: 'stroke', label: t('ink.eraserStroke'), on: tools.eraser === 'stroke', pick: () => eraserMode('stroke') },
            { id: 'part', label: t('ink.eraserPart'), on: tools.eraser === 'part', pick: () => eraserMode('part') },
          ])}
      </span>
      {button('lasso', toolLabel('lasso'), <Symbol name="lasso" className="h-4 w-4" />, () => choose('lasso'), { pressed: tools.tool === 'lasso', disabled: !writable })}
      {gap('g1')}
      {COLORS.map((color) =>
        button(
          'color-' + color,
          t(`ink.color.${color === INK ? 'ink' : color.slice(1)}`),
          <span
            className={'h-4.5 w-4.5 rounded-full border border-ink-600 ' + (color === INK ? 'bg-mist-100' : '')}
            style={color === INK ? undefined : { background: color }}
          />,
          () => setTools(pickColor(tools, color)),
          { pressed: tools.color === color, disabled: !writable },
        ),
      )}
      {gap('g2')}
      {SIZES.map((size) =>
        button(
          'size-' + size,
          t('ink.size', { size }),
          <span className="rounded-full bg-current" style={{ width: size + 3, height: size + 3 }} />,
          () => setTools({ ...tools, size }),
          { pressed: tools.size === size, disabled: !writable },
        ),
      )}
      {gap('g3')}
      {withPaper && (
        <span className="relative">
          {button('paper', t('ink.paper'), <Symbol name="paper" className="h-4 w-4" />, () => setOpen(open === 'paper' ? null : 'paper'), { disabled: !writable })}
          {open === 'paper' && menu(BACKGROUNDS.map((bg) => ({ id: bg, label: t(`ink.bg.${bg}`), on: ink.bg === bg, pick: () => paper(bg) })))}
        </span>
      )}
      {button('undo', t('ink.undo'), <Symbol name="undo" className="h-4 w-4" />, ink.undo, { disabled: !writable || !ink.canUndo })}
      {button('redo', t('ink.redo'), <Symbol name="redo" className="h-4 w-4" />, ink.redo, { disabled: !writable || !ink.canRedo })}
      {ink.selection.length > 0 && (
        <>
          {gap('g4')}
          {button('delete', t('ink.deleteChosen'), <Symbol name="trash" className="h-4 w-4" />, () => {
            ink.commit(removeStrokes(ink.strokes, ink.selection))
            ink.select([])
          })}
        </>
      )}
      {onDone && (
        <>
          {gap('g5')}
          <button
            type="button"
            data-ink-tool="done"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onDone}
            className="inline-flex h-8 items-center rounded-lg bg-accent-500 px-3 text-xs font-semibold text-on-accent hover:bg-accent-400"
          >
            {t('ink.done')}
          </button>
        </>
      )}
    </div>
  )
}
