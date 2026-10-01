/**
 * The editor's toolbar, fixed above the text like a word processor's: every command of the editor in one place, the
 * formats that hold where the caret is lit. Shown from the start; hiding it is remembered in this browser.
 *
 * On a phone it is one narrow row above the on-screen keyboard (`visualViewport` says where that is), swiped sideways.
 * Its buttons never take the focus from the text, so the keyboard stays and the command works where the caret was.
 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import type { EditorCommand, EditorStatus, NoteEditor } from '../editor/editor'
import type { MenuItem } from '../lib/menu'
import { CALLOUTS } from '../lib/toolbar'
import type { SymbolName } from '../lib/symbols'
import { Symbol } from './Symbol'

const NONE: EditorStatus = {
  marks: [], block: 'text', list: null, quote: false, table: false, headerRow: false,
  canUndo: false, canRedo: false, canIndent: false, canOutdent: false,
}

/** Narrow screens and touch: the row above the keyboard. */
function usePhone(): boolean {
  const query = '(max-width: 639px)'
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(query).matches)
  useEffect(() => {
    const list = window.matchMedia?.(query)
    if (!list) return
    const changed = () => setPhone(list.matches)
    list.addEventListener('change', changed)
    return () => list.removeEventListener('change', changed)
  }, [])
  return phone
}

/** How far the on-screen keyboard reaches up from the bottom of the window (0 without one). */
function useKeyboardInset(on: boolean): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const viewport = window.visualViewport
    if (!on || !viewport) return
    const measure = () => setInset(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop))
    measure()
    viewport.addEventListener('resize', measure)
    viewport.addEventListener('scroll', measure)
    return () => {
      viewport.removeEventListener('resize', measure)
      viewport.removeEventListener('scroll', measure)
    }
  }, [on])
  return inset
}

type Props = {
  editor: NoteEditor | null
  /** The AI's menu, when the account has AI switched on. */
  ai?: () => MenuItem[]
  onSource: () => void
  onHide: () => void
  /** The file's line numbers beside the text, and the switch for them. */
  lines: boolean
  onLines: () => void
  openMenu: (x: number, y: number, items: MenuItem[]) => void
  /** Find and replace (Ctrl+F), and its bar when it is open: a row under the tools, on a phone at the top. */
  onFind?: () => void
  findBar?: ReactNode
}

export function EditorToolbar({ editor, ai, onSource, onHide, lines, onLines, openMenu, onFind, findBar }: Props) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<EditorStatus>(NONE)
  const phone = usePhone()
  const inset = useKeyboardInset(phone)
  const frame = useRef(0)

  useEffect(() => {
    if (!editor) return
    const update = () => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(() => setStatus(editor.status()))
    }
    update()
    const stop = editor.subscribe(update)
    return () => {
      stop()
      cancelAnimationFrame(frame.current)
    }
  }, [editor])

  const run = (command: EditorCommand, option?: string) => editor?.run(command, option)
  const s = (key: string) => t(`editor.slash.${key}`)
  const below = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    // On a phone the row sits low: the menu opens above it.
    return phone ? { x: box.left, y: Math.max(8, box.top - 8 - 280) } : { x: box.left, y: box.bottom + 4 }
  }
  const has = (mark: string) => status.marks.includes(mark)
  const blockLabel = { text: s('text'), h1: s('h1'), h2: s('h2'), h3: s('h3'), code: s('code'), math: s('math') }[status.block] ?? s('text')

  const button = (key: string, label: string, symbol: SymbolName | null, onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void, options: { active?: boolean; disabled?: boolean; text?: string; menu?: boolean } = {}) => (
    <button
      key={key}
      type="button"
      data-tool={key}
      aria-label={label}
      title={label}
      aria-pressed={options.active === undefined ? undefined : options.active}
      aria-haspopup={options.menu ? 'menu' : undefined}
      disabled={!editor || options.disabled}
      // The text keeps the focus (and the phone its keyboard): the command works where the caret is.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={
        'inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg px-1.5 text-mist-300 hover:bg-ink-850 hover:text-mist-100 disabled:opacity-35 disabled:hover:bg-transparent ' +
        (options.text ? 'min-w-8 text-xs font-semibold ' : 'w-8 ') +
        (options.active ? 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/20 hover:text-accent-300' : '')
      }
    >
      {symbol && <Symbol name={symbol} className="h-4 w-4" />}
      {options.text && <span className="whitespace-nowrap">{options.text}</span>}
      {options.menu && <Symbol name="chevronDown" className="h-3 w-3 opacity-60" />}
    </button>
  )
  const gap = (key: string) => <span key={key} aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-ink-700" />

  const tools = [
    button('undo', t('toolbar.undo'), 'undo', () => run('undo'), { disabled: !status.canUndo }),
    button('redo', t('toolbar.redo'), 'redo', () => run('redo'), { disabled: !status.canRedo }),
    gap('g1'),
    button('block', t('toolbar.block'), null, (event) => {
      const at = below(event)
      openMenu(at.x, at.y, (['text', 'h1', 'h2', 'h3'] as const).map((kind) => ({ label: s(kind), onSelect: () => run(kind) })))
    }, { text: blockLabel, menu: true }),
    gap('g2'),
    button('bold', t('editorMenu.bold'), 'bold', () => run('bold'), { active: has('strong') }),
    button('italic', t('editorMenu.italic'), 'italic', () => run('italic'), { active: has('emphasis') }),
    button('strike', t('editorMenu.strike'), 'strike', () => run('strike'), { active: has('strike_through') }),
    button('highlight', t('editorMenu.highlight'), 'highlight', () => run('highlight')),
    button('code', t('editorMenu.code'), 'code', () => run('code'), { active: has('inlineCode') }),
    button('clear', t('toolbar.clear'), 'clearFormat', () => run('clear')),
    gap('g3'),
    button('wikiLink', s('wikiLink'), null, () => run('wikiLink'), { text: '[[ ]]' }),
    button('link', t('toolbar.link'), 'link', () => run('link'), { active: has('link') }),
    gap('g4'),
    button('bulletList', s('bulletList'), 'listBullet', () => run('bulletList'), { active: status.list === 'bullet' }),
    button('orderedList', s('orderedList'), 'listOrdered', () => run('orderedList'), { active: status.list === 'ordered' }),
    button('taskList', s('taskList'), 'listTask', () => run('taskList'), { active: status.list === 'task' }),
    button('outdent', t('toolbar.outdent'), 'outdent', () => run('outdent'), { disabled: !status.canOutdent }),
    button('indent', t('toolbar.indent'), 'indent', () => run('indent'), { disabled: !status.canIndent }),
    gap('g5'),
    button('quote', s('quote'), 'quote', () => run('quote'), { active: status.quote }),
    button('callout', s('callout'), 'info', (event) => {
      const at = below(event)
      openMenu(at.x, at.y, CALLOUTS.map((kind) => ({ label: t(`toolbar.callouts.${kind}`), onSelect: () => run('callout', kind) })))
    }, { menu: true }),
    button('codeBlock', s('code'), 'codeBlock', () => run('codeBlock'), { active: status.block === 'code' }),
    button('math', s('math'), 'sigma', () => run('math'), { active: status.block === 'math' }),
    button('divider', s('divider'), 'minus', () => run('divider')),
    button('table', s('table'), 'table', (event) => {
      if (!status.table) return run('table')
      const at = below(event)
      openMenu(at.x, at.y, [
        { label: t('toolbar.rowBefore'), disabled: status.headerRow, onSelect: () => run('rowBefore') },
        { label: t('toolbar.rowAfter'), onSelect: () => run('rowAfter') },
        { label: t('toolbar.colBefore'), onSelect: () => run('colBefore') },
        { label: t('toolbar.colAfter'), onSelect: () => run('colAfter') },
        'separator',
        {
          label: t('toolbar.align'),
          items: [
            { label: t('toolbar.alignNone'), onSelect: () => run('alignNone') },
            { label: t('toolbar.alignLeft'), onSelect: () => run('alignLeft') },
            { label: t('toolbar.alignCenter'), onSelect: () => run('alignCenter') },
            { label: t('toolbar.alignRight'), onSelect: () => run('alignRight') },
          ],
        },
        { label: t('toolbar.sortAsc'), onSelect: () => run('sortAsc') },
        { label: t('toolbar.sortDesc'), onSelect: () => run('sortDesc') },
        'separator',
        { label: t('toolbar.deleteRow'), disabled: status.headerRow, onSelect: () => run('deleteRow') },
        { label: t('toolbar.deleteCol'), onSelect: () => run('deleteCol') },
        { label: t('toolbar.deleteTable'), symbol: 'trash', onSelect: () => run('deleteTable') },
      ])
    }, { active: status.table, menu: status.table }),
    gap('g6'),
    button('attachment', s('attachment'), 'clip', () => run('attachment')),
    button('embed', s('embed'), 'embed', () => run('embed')),
    ...(ai
      ? [
          gap('g-ai'),
          button('ai', t('toolbar.ai'), 'sparkle', (event) => {
            const at = below(event)
            openMenu(at.x, at.y, ai())
          }, { text: t('toolbar.ai'), menu: true }),
        ]
      : []),
  ]
  const end = [
    ...(onFind ? [button('find', t('find.command') + ' (' + t('find.keyFind') + ')', 'search', onFind)] : []),
    button('lines', t('toolbar.lineNumbers'), 'lineNumbers', onLines, { active: lines }),
    button('source', t('note.sourceMode'), null, onSource, { text: 'MD' }),
    button('hide', t('toolbar.hide'), 'eyeOff', onHide),
  ]

  if (phone)
    return (
      <>
      {findBar && <div className="sticky top-0 z-20 -mx-1 mb-3 rounded-xl border border-ink-700 bg-ink-900/95 px-1.5 backdrop-blur">{findBar}</div>}
      <div
        role="toolbar"
        aria-label={t('toolbar.label')}
        data-testid="editor-toolbar"
        data-place="keyboard"
        style={{ bottom: inset }}
        className="fixed inset-x-0 z-30 flex h-11 items-center gap-0.5 overflow-x-auto overscroll-x-contain border-t border-ink-700 bg-ink-900/95 px-1.5 backdrop-blur [scrollbar-width:none]"
      >
        {tools}
        {gap('g7')}
        {end}
      </div>
      </>
    )

  return (
    <div
      role="toolbar"
      aria-label={t('toolbar.label')}
      data-testid="editor-toolbar"
      data-place="top"
      className="sticky top-0 z-20 -mx-1 mb-3 flex flex-wrap items-center gap-0.5 rounded-xl border border-ink-700 bg-ink-900/95 px-1.5 py-1 backdrop-blur [scrollbar-width:none] [@media(max-height:480px)]:flex-nowrap [@media(max-height:480px)]:overflow-x-auto [@media(max-height:480px)]:py-0.5"
    >
      {tools}
      <span className="ml-auto flex items-center gap-0.5">{end}</span>
      {findBar && <div className="basis-full border-t border-ink-700">{findBar}</div>}
    </div>
  )
}

/** Where the toolbar was: a small button brings it back. */
export function ShowToolbar({ onShow }: { onShow: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="mb-2 flex justify-end">
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onShow}
        className="inline-flex items-center gap-1.5 rounded-full border border-ink-700 px-2.5 py-1 text-xs text-mist-400 hover:bg-ink-850 hover:text-mist-200"
      >
        <Symbol name="eye" className="h-3.5 w-3.5" /> {t('toolbar.show')}
      </button>
    </div>
  )
}
