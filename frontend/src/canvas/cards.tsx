/**
 * The cards of a canvas, drawn by React Flow. Each shows what it holds the way nexlore shows it elsewhere (the reader
 * of `lib/markdown.ts`, pictures from the vault); a text card becomes the editor of the note page while it is edited.
 * A card is never wider than the canvas says: what does not fit scrolls once the card is chosen.
 */
import { Selection } from '@milkdown/kit/prose/state'
import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react'
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { fileUrl, linkTitleApi } from '../api/client'
import { Symbol } from '../components/Symbol'
import { createEditor, type NoteEditor } from '../editor/editor'
import { editorLabels } from '../editor/labels'
import { useEnrich } from '../lib/enrich'
import { fileKind, isNotePath } from '../lib/files'
import { LinkIndex } from '../lib/links'
import { noteSection, renderMarkdown } from '../lib/markdown'
import { useAuth } from '../state/auth'
import { useCards } from './context'
import { SIDES, colorOf, titleOf, type CanvasNode, type Side } from './model'

export type CardData = { node: CanvasNode }
export type CardNode = Node<CardData>

const POSITION: Record<Side, Position> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left }

/**
 * A point on each side to draw a line from or to. Only one kind: with loose connections (`ConnectionMode.Loose`)
 * React Flow ends a line on these too, and the line runs from where the drag began (a second, target point on top
 * turned it round).
 */
function Sides() {
  return (
    <>
      {SIDES.map((side) => (
        <Handle key={side} id={side} type="source" position={POSITION[side]} />
      ))}
    </>
  )
}

function Resizer({ selected }: { selected: boolean }) {
  const cards = useCards()
  return <NodeResizer isVisible={selected && !cards.readonly && !cards.touch && !cards.editing} minWidth={60} minHeight={36} />
}

/** The colour of a card as the frame's custom property, and the attribute the stylesheet looks for. */
function colored(node: CanvasNode): { style?: Record<string, string>; 'data-color'?: string } {
  const color = colorOf(node.color)
  return color ? { style: { '--card-color': color }, 'data-color': node.color } : {}
}

/** Rendered Markdown, with formulas and diagrams drawn after; links open beside the canvas or in a new tab. */
function Rendered({ html, base }: { html: string; base: string }) {
  const cards = useCards()
  const box = useRef<HTMLDivElement>(null)
  useEnrich(box, html)
  const click = (event: ReactMouseEvent) => {
    const anchor = (event.target as Element).closest('a')
    if (!anchor) return
    const note = anchor.getAttribute('data-note')
    const file = anchor.getAttribute('data-file')
    if (note) {
      event.preventDefault()
      cards.openNote(note)
    } else if (file) {
      event.preventDefault()
      cards.openFile(file)
    } else if (/^https?:/i.test(anchor.getAttribute('href') ?? '')) {
      event.preventDefault()
      window.open(anchor.href, '_blank', 'noopener,noreferrer')
    }
  }
  return <div ref={box} className="nn-prose nl-rendered" data-base={base} onClick={click} dangerouslySetInnerHTML={{ __html: html }} />
}

// --- Text ----------------------------------------------------------------------------------------------------------

export function TextCard({ id, data, selected }: NodeProps<CardNode>) {
  const cards = useCards()
  const { node } = data
  const editing = cards.editing === id
  const html = useMemo(
    () => renderMarkdown(node.text ?? '', (target) => cards.links.resolve(target), cards.path),
    // The links' answers come in later: `cards` changes with each of them (the page counts them).
    [node.text, cards],
  )
  return (
    <>
      <Resizer selected={selected} />
      <div className={'nl-card' + (editing ? ' nl-editing' : '')} data-title={titleOf(node)} {...colored(node)}>
        <div className={'nl-card-body' + (editing ? ' nodrag nopan nowheel' : '')}>
          {editing ? <CardEditor id={id} text={node.text ?? ''} /> : <Rendered html={html} base={cards.path} />}
        </div>
      </div>
      <Sides />
    </>
  )
}

/** The note page's editor in a card: one card at a time, its menus in the layer outside the zoomed canvas. */
function CardEditor({ id, text }: { id: string; text: string }) {
  const cards = useCards()
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement>(null)
  const latest = useRef(cards)
  latest.current = cards
  useEffect(() => {
    if (!host.current) return
    const root = document.createElement('div')
    host.current.appendChild(root)
    let alive = true
    let made: NoteEditor | null = null
    let timer = 0
    const index = latest.current.links
    // The editor ends a text with a line break; Obsidian writes a card's text without one. Kept only when it was there.
    const own = (out: string) => (text.endsWith('\n') ? out : out.replace(/\n+$/, ''))
    createEditor({
      root,
      original: text,
      browserCaret: true,
      labels: editorLabels(t),
      links: () => ({
        exists: (target) => index.exists(target),
        open: (target) => {
          const found = index.resolve(target)
          if (found) latest.current.openNote(found)
        },
        embed: () => null,
      }),
      search: () => (query) => index.search(query),
      onChange: () => {
        window.clearTimeout(timer)
        timer = window.setTimeout(() => made && latest.current.setText(id, own(made.text()), true), 400)
      },
      menus: latest.current.menus ?? undefined,
    })
      .then((editor) => {
        if (!alive) return void editor.destroy()
        made = editor
        // The caret at the end: typing goes on where the text stops.
        const { state } = editor.view
        editor.view.dispatch(state.tr.setSelection(Selection.atEnd(state.doc)))
        editor.view.focus()
      })
      .catch(() => latest.current.setEditing(null))
    return () => {
      alive = false
      window.clearTimeout(timer)
      if (made) {
        latest.current.setText(id, own(made.text()), false)
        const gone = made
        void gone.destroy().finally(() => root.remove())
      } else root.remove()
    }
    // One editor per card being edited; the text it starts from is read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  return <div ref={host} className="nl-card-editor" />
}

// --- Files: a note, a picture, anything else ------------------------------------------------------------------------

export function FileCard({ data, selected }: NodeProps<CardNode>) {
  const cards = useCards()
  const { t } = useTranslation()
  const { node } = data
  const { path, locked } = cards.target(node.file ?? '')
  const name = path.split('/').pop() ?? ''
  const kind = isNotePath(path) ? 'note' : fileKind(path)
  // Named on the card where it is another space than the canvas's.
  const from = path.split('/')[0] !== cards.space ? path.split('/')[0] : undefined
  return (
    <>
      <Resizer selected={selected} />
      {locked ? (
        // In a space whoever looks may not read: its name (written in the canvas anyway), never what it holds.
        <div className="nl-card nl-locked" data-title={name.replace(/\.md$/i, '')} data-locked="" {...colored(node)}>
          <div className="nl-card-head">
            <Symbol name="lock" className="h-3.5 w-3.5 shrink-0" />
            <b>{name.replace(/\.md$/i, '')}</b>
            {from && <span className="nl-card-space" title={from}>{from}</span>}
          </div>
          <div className="nl-card-body text-sm text-mist-500">{t('canvas.noAccess')}</div>
        </div>
      ) : kind === 'note' ? (
        <NoteBody node={node} path={path} from={from} />
      ) : kind === 'image' ? (
        <Picture node={node} path={path} name={name} from={from} />
      ) : (
        <div className="nl-card" data-title={name} {...colored(node)}>
          <div className="nl-card-body flex items-center gap-2">
            <Symbol name={kind === 'pdf' ? 'pdf' : 'file'} className="h-5 w-5 shrink-0 text-accent-400" />
            <span className="truncate text-sm font-medium">{name}</span>
            {from && <span className="nl-card-space" title={from}>{from}</span>}
            <span className="ml-auto shrink-0 text-xs text-mist-500">{t('canvas.file')}</span>
          </div>
        </div>
      )}
      <Sides />
    </>
  )
}

function NoteBody({ node, path, from }: { node: CanvasNode; path: string; from?: string }) {
  const cards = useCards()
  const { t } = useTranslation()
  const [text, setText] = useState<string | null | undefined>(undefined)
  const [answers, setAnswers] = useState(0)
  const index = useMemo(() => new LinkIndex(path, () => setAnswers((count) => count + 1)), [path])
  useEffect(() => {
    let alive = true
    cards.notes.get(path).then((found) => alive && setText(found), () => alive && setText(null))
    return () => {
      alive = false
    }
    // Again when the note was saved beside the canvas (`generation`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, cards.notes.generation])
  const section = node.subpath?.replace(/^#/, '') ?? ''
  const html = useMemo(() => {
    if (!text) return ''
    const body = section ? (noteSection(text, section) ?? text) : text
    return renderMarkdown(body, (target) => index.resolve(target), path)
    // `answers`: links found since.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, section, path, answers])
  const title = (path.split('/').pop() ?? '').replace(/\.md$/i, '') + (section ? ` › ${section}` : '')
  if (text === null) {
    return (
      <div className="nl-card nl-missing" data-title={title} {...colored(node)}>
        <div className="nl-card-body">{t('canvas.missingNote', { name: title })}</div>
      </div>
    )
  }
  return (
    <div className="nl-card" data-title={title} {...colored(node)}>
      <div className="nl-card-head">
        <Symbol name="note" className="h-3.5 w-3.5 shrink-0" />
        <b>{title}</b>
        {from && <span className="nl-card-space" title={from}>{from}</span>}
        <span className="ml-auto shrink-0">{t('canvas.note')}</span>
      </div>
      <div className="nl-card-body">
        {text === undefined ? (
          <p className="text-xs text-mist-500">{t('common.loading')}</p>
        ) : text.trim() === '' ? (
          <p className="text-sm text-mist-500 italic">{t('canvas.emptyNote')}</p>
        ) : (
          <Rendered html={html} base={path} />
        )}
      </div>
    </div>
  )
}

function Picture({ node, path, name, from }: { node: CanvasNode; path: string; name: string; from?: string }) {
  const { t } = useTranslation()
  const [broken, setBroken] = useState(false)
  if (broken) {
    return (
      <div className="nl-card nl-missing" data-title={name} {...colored(node)}>
        <div className="nl-card-body">{t('canvas.missingFile', { name })}</div>
      </div>
    )
  }
  return (
    <div className="nl-card nl-picture" data-title={name} {...colored(node)}>
      <div className="nl-card-body">
        <img src={fileUrl(path)} alt={name} draggable={false} onError={() => setBroken(true)} />
        {from && <span className="nl-card-space nl-card-space-over" title={from}>{from}</span>}
      </div>
    </div>
  )
}

// --- Links, groups, and kinds nexlore does not know -----------------------------------------------------------------

export function LinkCard({ data, selected }: NodeProps<CardNode>) {
  const { t } = useTranslation()
  const { me } = useAuth()
  const { node } = data
  const url = node.url ?? ''
  const [title, setTitle] = useState<string | null>(null)
  useEffect(() => {
    // Only when the operator lets the server ask other pages (`link_titles`); otherwise the address alone.
    if (!me?.link_titles || !/^https?:/i.test(url)) return
    let alive = true
    linkTitleApi.title(url).then((found) => alive && setTitle(found.title), () => undefined)
    return () => {
      alive = false
    }
  }, [url, me?.link_titles])
  const host = titleOf(node)
  return (
    <>
      <Resizer selected={selected} />
      <div className="nl-card nl-link" data-title={host} {...colored(node)}>
        <div className="nl-card-body">
          <span className="flex items-center gap-1.5 truncate font-semibold text-mist-100">
            <Symbol name="link" className="h-4 w-4 shrink-0 text-accent-400" />
            <span className="truncate">{title || host}</span>
          </span>
          <a
            href={/^https?:/i.test(url) ? url : undefined}
            target="_blank"
            rel="noopener noreferrer"
            className="nodrag truncate text-xs text-mist-500 hover:text-accent-400"
            title={t('canvas.openLink')}
          >
            {url}
          </a>
        </div>
      </div>
      <Sides />
    </>
  )
}

export function GroupCard({ data, selected }: NodeProps<CardNode>) {
  const cards = useCards()
  const { node } = data
  const color = colorOf(node.color)
  const behind = node.background ? cards.target(node.background) : null
  const background = behind && !behind.locked ? fileUrl(behind.path) : null
  const fill = node.backgroundStyle === 'repeat' ? 'auto' : node.backgroundStyle === 'ratio' ? 'contain' : 'cover'
  return (
    <>
      <Resizer selected={selected} />
      <div
        className="nl-group"
        data-color={color ? node.color : undefined}
        style={{
          ...(color ? { '--card-color': color } : {}),
          ...(background
            ? { backgroundImage: `url("${background.replace(/"/g, '%22')}")`, backgroundSize: fill, backgroundRepeat: node.backgroundStyle === 'repeat' ? 'repeat' : 'no-repeat' }
            : {}),
        }}
      >
        {node.label && <span className="nl-group-label">{node.label}</span>}
      </div>
      <Sides />
    </>
  )
}

export function OtherCard({ data, selected }: NodeProps<CardNode>) {
  const { t } = useTranslation()
  const { node } = data
  return (
    <>
      <Resizer selected={selected} />
      <div className="nl-card nl-missing" data-title={node.type}>
        <div className="nl-card-body">{t('canvas.otherKind', { kind: node.type })}</div>
      </div>
      <Sides />
    </>
  )
}
