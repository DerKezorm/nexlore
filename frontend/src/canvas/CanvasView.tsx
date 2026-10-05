/**
 * The canvas itself: React Flow drawing the cards and lines of a `Canvas`, every change handed up as a new canvas
 * (`apply`). Live changes (a card on its way, text being typed) are saved but make no step of their own to go back
 * to; the step is made when the move or the edit ends.
 *
 * What React Flow does not know, done here: a group carries what lies in it (JSON Canvas has no parent, only place),
 * cards snap to each other while they move or grow (`snap.ts`, Alt the other way), a line's sides and ends as the
 * format writes them, its way around the cards in between (`route.ts`), and far out only titles (`nl-far`).
 */
import {
  BaseEdge,
  ConnectionMode,
  EdgeText,
  MarkerType,
  NodeToolbar,
  Panel,
  Position,
  ReactFlow,
  getBezierPath,
  useReactFlow,
  useStore,
  useViewport,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type NodeChange,
  type NodeMouseHandler,
  type OnConnectEnd,
  type OnDelete,
  type OnNodeDrag,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { Symbol } from '../components/Symbol'
import { PATH_DRAG_TYPE, fileKind, isNotePath } from '../lib/files'
import { useContextMenu, type MenuItem } from '../lib/menu'
import { askFolder } from '../lib/shell'
import type { SymbolName } from '../lib/symbols'
import { FileCard, GroupCard, LinkCard, OtherCard, TextCard, type CardNode } from './cards'
import { useCards, writtenPath } from './context'
import { AskDialog, PickDialog } from './dialogs'
import {
  PRESET_COLORS,
  addEdge,
  addNode,
  bounds,
  colorOf,
  facingSides,
  inGroup,
  makeEdge,
  makeNode,
  nearestSide,
  removeEdges,
  removeNodes,
  titleOf,
  updateEdge,
  updateNodes,
  type Canvas,
  type CanvasEdge,
  type CanvasNode,
  type Side,
} from './model'
import { middleOf, pathOf, port, route, type Point } from './route'
import { moving, snap } from './snap'

/** Below this zoom a card shows only its title, as on the map. */
export const FAR_ZOOM = 0.45

// Not "group": React Flow styles a node type of that name itself (a grey ground, a frame and padding).
const NODE_TYPES = { text: TextCard, file: FileCard, link: LinkCard, frame: GroupCard, other: OtherCard }
const EDGE_TYPES = { line: LineEdge }
const KIND: Record<string, keyof typeof NODE_TYPES> = { text: 'text', file: 'file', link: 'link', group: 'frame' }

/** A line as drawn: its way around the cards, or (none found) the two ends a curve joins. */
type LineData = { edge: CanvasEdge; way: Point[] | null; from: Point; fromSide: Side; to: Point; toSide: Side }
type LineEdgeType = Edge<LineData, 'line'>

export type Apply = (next: Canvas, live?: boolean) => void

type Props = {
  canvas: Canvas
  apply: Apply
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  snapping: boolean
  setSnapping: (on: boolean) => void
}

type Asking =
  | { kind: 'link'; at: { x: number; y: number } }
  | { kind: 'group-label'; id: string; initial: string }
  | { kind: 'edge-label'; id: string; initial: string }
  | { kind: 'pick'; files: boolean; at: { x: number; y: number } }

const DEFAULT_SIZE: Record<string, { width: number; height: number }> = {
  text: { width: 260, height: 120 },
  note: { width: 400, height: 300 },
  image: { width: 320, height: 220 },
  file: { width: 300, height: 64 },
  link: { width: 300, height: 90 },
  group: { width: 480, height: 320 },
}

export function CanvasView({ canvas, apply: handUp, undo, redo, canUndo, canRedo, snapping, setSnapping }: Props) {
  const cards = useCards()
  const { t } = useTranslation()
  const flow = useReactFlow<CardNode, LineEdgeType>()
  const { zoom } = useViewport()
  const menu = useContextMenu()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] })
  const [asking, setAsking] = useState<Asking | null>(null)
  const [dragging, setDragging] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)
  const alt = useRef(false)
  // A move under way: where everything that moves stood when it began, and the canvas then.
  const drag = useRef<{ start: Map<string, { x: number; y: number }>; carried: Set<string> } | null>(null)
  const latest = useRef(canvas)
  latest.current = canvas
  // Two changes in one moment (Delete takes cards and lines apart) build on each other, not on the last drawing.
  const apply = useCallback<Apply>((next, live) => {
    latest.current = next
    handUp(next, live)
  }, [handUp])
  const editable = !cards.readonly
  const arrange = editable && !cards.touch

  // Alt while dragging turns snapping the other way; followed on the window, the mouse events do not carry it to us.
  useEffect(() => {
    const key = (event: KeyboardEvent) => (alt.current = event.altKey)
    window.addEventListener('keydown', key)
    window.addEventListener('keyup', key)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('keyup', key)
    }
  }, [])

  // Cards that are gone are no longer chosen.
  useEffect(() => {
    const there = new Set([...canvas.nodes.map((node) => node.id), ...canvas.edges.map((edge) => edge.id)])
    setSelected((now) => ([...now].every((id) => there.has(id)) ? now : new Set([...now].filter((id) => there.has(id)))))
  }, [canvas])

  const nodes = useMemo<CardNode[]>(
    () =>
      canvas.nodes.map((node) => ({
        id: node.id,
        type: KIND[node.type] ?? 'other',
        position: { x: node.x, y: node.y },
        width: node.width,
        height: node.height,
        data: { node },
        selected: selected.has(node.id),
        // Groups lie below the lines and the cards; nothing else is lifted (the array order is the format's).
        zIndex: node.type === 'group' ? -1 : 0,
        draggable: arrange && cards.editing !== node.id,
        connectable: arrange,
        ariaLabel: titleOf(node) || node.type,
      })),
    [canvas.nodes, selected, arrange, cards.editing],
  )

  // Each line's way, worked out again whenever a card or a line changes. Groups stand in no way: lines run into
  // them and through them, only around the cards.
  const drawn = useMemo(() => {
    const byId = new Map(canvas.nodes.map((node) => [node.id, node]))
    const cards = canvas.nodes.filter((node) => node.type !== 'group')
    const out = new Map<string, LineData>()
    for (const edge of canvas.edges) {
      const from = byId.get(edge.fromNode)
      const to = byId.get(edge.toNode)
      if (!from || !to) continue
      const [facingFrom, facingTo] = facingSides(from, to)
      const fromSide = edge.fromSide ?? facingFrom
      const toSide = edge.toSide ?? facingTo
      const way = route({ from, fromSide, to, toSide }, cards)
      out.set(edge.id, { edge, way, from: port(from, fromSide), fromSide, to: port(to, toSide), toSide })
    }
    return out
  }, [canvas.edges, canvas.nodes])

  const edges = useMemo<LineEdgeType[]>(() => {
    return canvas.edges.flatMap((edge) => {
      const data = drawn.get(edge.id)
      if (!data) return []
      const color = colorOf(edge.color) ?? undefined
      const marker = { type: MarkerType.ArrowClosed, width: 18, height: 18, color: color ?? 'var(--color-mist-500)' }
      return [
        {
          id: edge.id,
          type: 'line' as const,
          source: edge.fromNode,
          target: edge.toNode,
          sourceHandle: data.fromSide,
          targetHandle: data.toSide,
          data,
          selected: selected.has(edge.id),
          markerEnd: edge.toEnd === 'none' ? undefined : marker,
          markerStart: edge.fromEnd === 'arrow' ? marker : undefined,
          style: color ? { stroke: color } : undefined,
          interactionWidth: 18,
          // A way around the cards lies above them (it crosses none). A curve, drawn where cards lie on each other
          // and no way is found, lies under them: over a card it ran across the text of the card on top.
          zIndex: data.way ? 1 : 0,
        },
      ]
    })
  }, [canvas.edges, drawn, selected])

  // --- Moving, growing, choosing, removing ------------------------------------------------------------------------

  const onNodeDragStart: OnNodeDrag<CardNode> = useCallback((_event, _node) => {
    const current = latest.current
    const moved = new Set(flow.getNodes().filter((item) => item.dragging || item.selected).map((item) => item.id))
    moved.add(_node.id)
    // A group carries what lies wholly inside it, groups in it with theirs.
    const carried = new Set<string>()
    const queue = current.nodes.filter((node) => moved.has(node.id) && node.type === 'group')
    while (queue.length) {
      const group = queue.pop()!
      for (const inside of inGroup(current, group)) {
        if (moved.has(inside.id) || carried.has(inside.id)) continue
        carried.add(inside.id)
        if (inside.type === 'group') queue.push(inside)
      }
    }
    const start = new Map<string, { x: number; y: number }>()
    for (const node of current.nodes) if (moved.has(node.id) || carried.has(node.id)) start.set(node.id, { x: node.x, y: node.y })
    drag.current = { start, carried }
    setDragging(true)
  }, [flow])

  const onNodesChange = useCallback(
    (changes: NodeChange<CardNode>[]) => {
      const current = latest.current
      let choose: Set<string> | null = null
      const moves = new Map<string, { x: number; y: number }>()
      const sizes = new Map<string, { width: number; height: number; position?: { x: number; y: number } }>()
      let moveEnds = false
      let sizeEnds = false
      for (const change of changes) {
        if (change.type === 'select') {
          choose ??= new Set(selected)
          if (change.selected) choose.add(change.id)
          else choose.delete(change.id)
        } else if (change.type === 'position') {
          if (change.position && change.dragging) moves.set(change.id, change.position)
          if (change.dragging === false) moveEnds = true
        } else if (change.type === 'dimensions' && change.resizing !== undefined && change.dimensions) {
          sizes.set(change.id, { ...change.dimensions })
          if (!change.resizing) sizeEnds = true
        }
        // Removals come from the Delete key and are taken in `onDelete`, cards and lines as one step.
      }
      // Growing from the left or the top moves the card too: React Flow sends both.
      for (const [id, size] of sizes) {
        const position = moves.get(id)
        if (position) {
          size.position = position
          moves.delete(id)
        }
      }
      if (choose) setSelected(choose)

      if (moves.size && drag.current) {
        const { start } = drag.current
        const [firstId, firstAt] = [...moves][0]
        const from = start.get(firstId)
        if (from) {
          let dx = firstAt.x - from.x
          let dy = firstAt.y - from.y
          const movingNodes = current.nodes.filter((node) => start.has(node.id))
          const box = bounds(movingNodes.map((node) => ({ ...node, x: start.get(node.id)!.x + dx, y: start.get(node.id)!.y + dy })))
          let lines = { x: [] as number[], y: [] as number[] }
          if (box && snapping !== alt.current) {
            const others = current.nodes.filter((node) => !start.has(node.id))
            const snapped = snap(moving(box), others, zoom)
            dx += snapped.dx
            dy += snapped.dy
            lines = { x: snapped.guidesX, y: snapped.guidesY }
          }
          setGuides(lines)
          const change: Record<string, Partial<CanvasNode>> = {}
          for (const [id, at] of start) change[id] = { x: at.x + dx, y: at.y + dy }
          apply(updateNodes(current, change), true)
        }
      }
      if (moveEnds && drag.current) {
        drag.current = null
        setDragging(false)
        setGuides({ x: [], y: [] })
        apply(latest.current)
      }

      if (sizes.size) {
        const change: Record<string, Partial<CanvasNode>> = {}
        let lines = { x: [] as number[], y: [] as number[] }
        for (const [id, size] of sizes) {
          const node = current.nodes.find((item) => item.id === id)
          if (!node) continue
          let { width, height } = size
          const x = size.position?.x ?? node.x
          const y = size.position?.y ?? node.y
          // Only the right and the lower edge snap (growing from there is the usual way).
          if (!size.position && snapping !== alt.current) {
            const snapped = snap({ x: [x + width], y: [y + height] }, current.nodes.filter((item) => item.id !== id), zoom)
            width += snapped.dx
            height += snapped.dy
            lines = { x: snapped.guidesX, y: snapped.guidesY }
          }
          change[id] = { x, y, width, height }
        }
        setGuides(sizeEnds ? { x: [], y: [] } : lines)
        apply(updateNodes(current, change), !sizeEnds)
      }
    },
    [apply, selected, snapping, zoom],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange<LineEdgeType>[]) => {
      let choose: Set<string> | null = null
      for (const change of changes) {
        if (change.type === 'select') {
          choose ??= new Set(selected)
          if (change.selected) choose.add(change.id)
          else choose.delete(change.id)
        }
      }
      if (choose) setSelected(choose)
    },
    [selected],
  )

  // The Delete key: chosen cards with every line at them, and chosen lines, as one step. React Flow reports the
  // lines and the cards as two changes; taken there they were two steps, and one step back left the lines away.
  const onDelete: OnDelete<CardNode, LineEdgeType> = useCallback(
    ({ nodes: cardsGone, edges: linesGone }) => {
      if (!editable) return
      const current = latest.current
      apply(removeEdges(removeNodes(current, cardsGone.map((node) => node.id)), linesGone.map((edge) => edge.id)))
    },
    [apply, editable],
  )

  // A line ends where it was let go: on a point, that point's side (the person chose it); anywhere else on a card,
  // the side nearest the pointer, so letting go near the bottom of a card ends at its bottom (as in Obsidian).
  const connect = useCallback(
    (from: string, fromSide: Side | undefined, to: string, toSide: Side) => {
      const current = latest.current
      if (from === to || !current.nodes.some((node) => node.id === to)) return
      apply(addEdge(current, makeEdge(current, { node: from, side: fromSide }, { node: to, side: toSide })))
    },
    [apply],
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!editable || !connection.targetHandle) return
      connect(connection.source, (connection.sourceHandle ?? undefined) as Side | undefined, connection.target, connection.targetHandle as Side)
    },
    [connect, editable],
  )

  const onConnectEnd: OnConnectEnd = useCallback(
    (event, state) => {
      if (!editable || state.isValid || !state.fromNode) return
      const point = 'changedTouches' in event ? event.changedTouches[0] : event
      const card = document.elementsFromPoint(point.clientX, point.clientY).find((element) => element.classList.contains('react-flow__node'))
      const to = card?.getAttribute('data-id')
      if (!card || !to) return
      connect(state.fromNode.id, (state.fromHandle?.id ?? undefined) as Side | undefined, to, nearestSide(card.getBoundingClientRect(), point.clientX, point.clientY))
    },
    [connect, editable],
  )

  // --- Making cards ----------------------------------------------------------------------------------------------

  const center = useCallback(() => {
    const box = wrapper.current?.getBoundingClientRect()
    return box ? flow.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 }) : { x: 0, y: 0 }
  }, [flow])

  const place = useCallback(
    (what: Parameters<typeof makeNode>[1], size: { width: number; height: number }, at: { x: number; y: number }, edit = false) => {
      const node = makeNode(latest.current, what, { x: at.x - size.width / 2, y: at.y - size.height / 2, ...size })
      apply(addNode(latest.current, node))
      setSelected(new Set([node.id]))
      if (edit) cards.setEditing(node.id)
      return node
    },
    [apply, cards],
  )

  const placeFile = useCallback(
    (path: string, at: { x: number; y: number }) => {
      // From another space too: written with its space's name in front (Obsidian on the whole vault), shown to
      // whoever may read that space and locked for anybody else.
      const written = writtenPath(cards.space, path)
      if (written === path) cards.remember(written, path)
      const kind = isNotePath(path) ? 'note' : fileKind(path) === 'image' ? 'image' : 'file'
      place({ type: 'file', file: written }, DEFAULT_SIZE[kind], at)
    },
    [cards, place],
  )

  const onDoubleClick = (event: ReactMouseEvent) => {
    const target = event.target as Element
    if (!editable || !target.classList.contains('react-flow__pane')) return
    place({ type: 'text', text: '' }, DEFAULT_SIZE.text, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }), true)
  }

  const onNodeDoubleClick: NodeMouseHandler<CardNode> = (_event, item) => {
    const node = item.data.node
    if (node.type === 'text' && editable) cards.setEditing(node.id)
    else if (node.type === 'file' && node.file) {
      const { path, locked } = cards.target(node.file)
      if (locked) return
      if (isNotePath(path)) cards.openNote(path)
      else cards.openFile(path)
    } else if (node.type === 'link' && /^https?:/i.test(node.url ?? '')) window.open(node.url, '_blank', 'noopener,noreferrer')
    else if (node.type === 'group' && editable) setAsking({ kind: 'group-label', id: node.id, initial: node.label ?? '' })
  }

  const onDragOver = (event: DragEvent) => {
    if (editable && event.dataTransfer.types.includes(PATH_DRAG_TYPE)) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
  }
  const onDrop = (event: DragEvent) => {
    const path = event.dataTransfer.getData(PATH_DRAG_TYPE)
    if (!path || !editable) return
    event.preventDefault()
    placeFile(path, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }))
  }

  // --- Keys ------------------------------------------------------------------------------------------------------

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = !!target?.closest('input, textarea, [contenteditable="true"], .milkdown')
      if (event.key === 'Escape') {
        if (cards.editing) cards.setEditing(null)
        else setSelected(new Set())
        return
      }
      if (typing || !editable) return
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redo()
      } else if (mod && event.key.toLowerCase() === 'a' && !target?.closest('aside, [role="dialog"], dialog')) {
        // Every card, wherever the keys are on this page (before any click they are on the page itself, and the
        // browser chose all its text); not in the sidebar, the note beside the canvas, or a dialog.
        event.preventDefault()
        setSelected(new Set(latest.current.nodes.map((node) => node.id)))
      } else if (event.key === 'Enter' && selected.size === 1) {
        const node = latest.current.nodes.find((item) => selected.has(item.id))
        if (node?.type === 'text') {
          event.preventDefault()
          cards.setEditing(node.id)
        }
      }
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [cards, editable, redo, undo, selected])

  // --- What the chosen cards can do --------------------------------------------------------------------------------

  const chosenNodes = canvas.nodes.filter((node) => selected.has(node.id))
  const chosenEdge = selected.size === 1 ? canvas.edges.find((edge) => selected.has(edge.id)) : undefined

  const paint = (color: string | undefined) => {
    if (chosenEdge) return apply(updateEdge(canvas, chosenEdge.id, { color }))
    apply(updateNodes(canvas, Object.fromEntries(chosenNodes.map((node) => [node.id, { color }]))))
  }

  const actions = (nodesNow: CanvasNode[]): MenuItem[] => {
    const items: MenuItem[] = []
    const single = nodesNow.length === 1 ? nodesNow[0] : null
    if (single?.type === 'text' && editable) items.push({ label: t('canvas.edit'), symbol: 'pencil', onSelect: () => cards.setEditing(single.id) })
    if (single?.type === 'file' && single.file && !cards.target(single.file).locked) {
      const { path } = cards.target(single.file)
      if (isNotePath(path)) {
        items.push({ label: t('canvas.edit'), symbol: 'pencil', onSelect: () => cards.openNote(path) })
        items.push({ label: t('canvas.openPage'), symbol: 'open', onSelect: () => cards.openFile(path) })
      } else items.push({ label: t('canvas.openPage'), symbol: 'open', onSelect: () => cards.openFile(path) })
      items.push({ label: t('canvas.reveal'), symbol: 'sidebar', onSelect: () => askFolder(path) })
    }
    if (single?.type === 'group' && editable) items.push({ label: t('canvas.rename'), symbol: 'pencil', onSelect: () => setAsking({ kind: 'group-label', id: single.id, initial: single.label ?? '' }) })
    if (editable && nodesNow.length) {
      items.push({
        label: t('canvas.color'),
        symbol: 'star',
        items: [
          { label: t('canvas.noColor'), onSelect: () => apply(updateNodes(latest.current, Object.fromEntries(nodesNow.map((node) => [node.id, { color: undefined }])))) },
          ...PRESET_COLORS.map((color) => ({
            label: t(`canvas.colors.${color}`),
            onSelect: () => apply(updateNodes(latest.current, Object.fromEntries(nodesNow.map((node) => [node.id, { color }])))),
          })),
        ],
      })
      items.push('separator')
      items.push({ label: t('canvas.remove'), symbol: 'trash', danger: true, onSelect: () => apply(removeNodes(latest.current, nodesNow.map((node) => node.id))) })
    }
    return items
  }

  const onNodeContextMenu: NodeMouseHandler<CardNode> = (event, item) => {
    event.preventDefault()
    const chosen = selected.has(item.id) ? canvas.nodes.filter((node) => selected.has(node.id)) : [item.data.node]
    if (!selected.has(item.id)) setSelected(new Set([item.id]))
    menu.open(event.clientX, event.clientY, actions(chosen))
  }

  const onPaneContextMenu = (event: ReactMouseEvent | MouseEvent) => {
    event.preventDefault()
    if (!editable) return
    const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    menu.open(event.clientX, event.clientY, [
      { label: t('canvas.add.text'), symbol: 'pencil', onSelect: () => place({ type: 'text', text: '' }, DEFAULT_SIZE.text, at, true) },
      { label: t('canvas.add.note'), symbol: 'note', onSelect: () => setAsking({ kind: 'pick', files: false, at }) },
      { label: t('canvas.add.file'), symbol: 'image', onSelect: () => setAsking({ kind: 'pick', files: true, at }) },
      { label: t('canvas.add.link'), symbol: 'link', onSelect: () => setAsking({ kind: 'link', at }) },
      { label: t('canvas.add.group'), symbol: 'columns', onSelect: () => place({ type: 'group', label: t('canvas.group') }, DEFAULT_SIZE.group, at) },
      'separator',
      { label: t('canvas.fit'), symbol: 'fit', onSelect: () => void flow.fitView({ padding: 0.15, duration: 200 }) },
    ])
  }

  const far = zoom < FAR_ZOOM
  return (
    <div
      ref={wrapper}
      className={'nl-canvas' + (far ? ' nl-far' : '') + (editable ? '' : ' nl-readonly')}
      style={{ '--nl-zoom': zoom } as CSSProperties}
      onDoubleClick={onDoubleClick}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <ReactFlow<CardNode, LineEdgeType>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onDelete={onDelete}
        onNodeDragStart={onNodeDragStart}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeContextMenu={onNodeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        onPaneClick={() => cards.editing && cards.setEditing(null)}
        connectionMode={ConnectionMode.Loose}
        nodesDraggable={arrange}
        nodesConnectable={arrange}
        elementsSelectable
        deleteKeyCode={editable ? ['Delete', 'Backspace'] : null}
        multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
        selectionKeyCode={null}
        selectionOnDrag={false}
        panOnDrag
        zoomOnDoubleClick={false}
        elevateNodesOnSelect={false}
        onlyRenderVisibleElements
        minZoom={0.05}
        maxZoom={4}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        colorMode="system"
      >
        {arrange && !dragging && chosenNodes.length > 0 && !cards.editing && (
          // Above everything: React Flow lifts a bar one above its cards, and a group's (which lies at -1) was then under
          // the canvas's own surface, which took every click.
          <NodeToolbar nodeId={chosenNodes.map((node) => node.id)} isVisible offset={12} style={{ zIndex: 1000 }}>
            <div className="flex items-center gap-1 rounded-xl border border-ink-600 bg-ink-850 p-1 shadow-xl" role="toolbar" aria-label={t('canvas.chosen')}>
              <Swatches current={chosenNodes.length === 1 ? chosenNodes[0].color : undefined} onPick={paint} />
              <span className="mx-0.5 h-5 w-px bg-ink-600" />
              {actions(chosenNodes)
                .filter((item): item is Extract<MenuItem, { onSelect: () => void }> => typeof item === 'object' && 'onSelect' in item)
                .map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={item.onSelect}
                    title={item.label}
                    aria-label={item.label}
                    className={'rounded-lg px-2 py-1 text-sm hover:bg-ink-700 ' + (item.danger ? 'text-bad-500' : 'text-mist-300')}
                  >
                    {item.symbol === 'trash' ? <Symbol name="trash" className="h-4 w-4" /> : item.label}
                  </button>
                ))}
            </div>
          </NodeToolbar>
        )}
        <Panel position="top-right">
          <ZoomBar undo={undo} redo={redo} canUndo={canUndo} canRedo={canRedo} snapping={snapping} setSnapping={setSnapping} />
        </Panel>
        {editable && (
          // On a phone the dock reaches into the corner of Lore's spider: it stands above it there.
          <Panel position="bottom-center" className="max-sm:!mb-[var(--lore-corner,15px)]">
            <Dock
              touch={cards.touch}
              add={(kind) => {
                const at = center()
                if (kind === 'text') place({ type: 'text', text: '' }, DEFAULT_SIZE.text, at, true)
                else if (kind === 'note') setAsking({ kind: 'pick', files: false, at })
                else if (kind === 'file') setAsking({ kind: 'pick', files: true, at })
                else if (kind === 'link') setAsking({ kind: 'link', at })
                else if (kind === 'group') place({ type: 'group', label: t('canvas.group') }, DEFAULT_SIZE.group, at)
                else void flow.fitView({ padding: 0.15, duration: 200 })
              }}
            />
          </Panel>
        )}
      </ReactFlow>
      {(guides.x.length > 0 || guides.y.length > 0) && <Guides x={guides.x} y={guides.y} />}
      {chosenEdge && editable && !cards.touch && (
        <EdgeTools
          edge={chosenEdge}
          onLabel={() => setAsking({ kind: 'edge-label', id: chosenEdge.id, initial: chosenEdge.label ?? '' })}
          onEnds={() =>
            apply(updateEdge(canvas, chosenEdge.id, chosenEdge.fromEnd === 'arrow' ? { fromEnd: undefined } : { fromEnd: 'arrow' }))
          }
          onColor={paint}
          onRemove={() => apply(removeEdges(canvas, [chosenEdge.id]))}
        />
      )}
      {menu.element}
      {asking?.kind === 'pick' && (
        <PickDialog
          space={cards.space}
          files={asking.files}
          onClose={() => setAsking(null)}
          onPick={(path) => {
            placeFile(path, asking.at)
            setAsking(null)
          }}
        />
      )}
      {asking?.kind === 'link' && (
        <AskDialog
          title={t('canvas.add.link')}
          label={t('canvas.address')}
          initial="https://"
          onClose={() => setAsking(null)}
          onDone={(url) => {
            place({ type: 'link', url }, DEFAULT_SIZE.link, asking.at)
            setAsking(null)
          }}
        />
      )}
      {asking?.kind === 'group-label' && (
        <AskDialog
          title={t('canvas.rename')}
          label={t('canvas.groupName')}
          initial={asking.initial}
          allowEmpty
          onClose={() => setAsking(null)}
          onDone={(label) => {
            apply(updateNodes(latest.current, { [asking.id]: { label: label || undefined } }))
            setAsking(null)
          }}
        />
      )}
      {asking?.kind === 'edge-label' && (
        <AskDialog
          title={t('canvas.label')}
          label={t('canvas.label')}
          initial={asking.initial}
          allowEmpty
          onClose={() => setAsking(null)}
          onDone={(label) => {
            apply(updateEdge(latest.current, asking.id, { label: label || undefined }))
            setAsking(null)
          }}
        />
      )}
    </div>
  )
}

/** Smallest a line's label gets on the screen, in pixels, however far out (12 px at 0.75 were hard to read). */
const LABEL_LEAST = 13
const LABEL_SIZE = 14

/**
 * A line's label, drawn with the line (not in a layer above everything): under the cards with a curve that runs under
 * them, above with a way around them. On the canvas's ground, so the line stops behind it; grown back when zoomed out
 * far enough to shrink it (grown as a whole: React Flow measures the text once, at its size).
 */
function LineLabel({ label, x, y }: { label: string; x: number; y: number }) {
  const zoom = useStore((state) => state.transform[2])
  const grow = Math.max(1, LABEL_LEAST / (LABEL_SIZE * zoom))
  return (
    <g transform={`translate(${x} ${y}) scale(${grow}) translate(${-x} ${-y})`}>
      <EdgeText
        x={x}
        y={y}
        label={label}
        className="nl-edge-label"
        labelStyle={{ fontSize: LABEL_SIZE, fontWeight: 500, fill: 'var(--color-mist-100)' }}
        labelBgStyle={{ fill: 'var(--color-ink-950)', stroke: 'var(--color-ink-600)', strokeWidth: 1 }}
        labelBgPadding={[8, 3]}
        labelBgBorderRadius={6}
      />
    </g>
  )
}

const POSITION: Record<Side, Position> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left }

/**
 * A line: its way around the cards, corners rounded, or where none is found a curve from side to side; the label
 * halfway. Both end on the cards' edges (React Flow's own ends lie at the outer edge of the points to draw from).
 */
function LineEdge({ id, markerEnd, markerStart, style, data }: EdgeProps<LineEdgeType>) {
  const [path, labelX, labelY] = useMemo(() => {
    if (!data) return ['', 0, 0] as const
    if (data.way) {
      const middle = middleOf(data.way)
      return [pathOf(data.way), middle.x, middle.y] as const
    }
    const [curve, x, y] = getBezierPath({
      sourceX: data.from.x,
      sourceY: data.from.y,
      sourcePosition: POSITION[data.fromSide],
      targetX: data.to.x,
      targetY: data.to.y,
      targetPosition: POSITION[data.toSide],
    })
    return [curve, x, y] as const
  }, [data])
  const label = data?.edge.label
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} markerStart={markerStart} style={style} interactionWidth={18} />
      {label && <LineLabel label={label} x={labelX} y={labelY} />}
    </>
  )
}

function Swatches({ current, onPick }: { current?: string; onPick: (color: string | undefined) => void }) {
  const { t } = useTranslation()
  return (
    <span className="flex items-center gap-1 px-1">
      <button
        type="button"
        onClick={() => onPick(undefined)}
        title={t('canvas.noColor')}
        aria-label={t('canvas.noColor')}
        aria-pressed={!current}
        className="h-5 w-5 rounded-full border border-ink-600 bg-[conic-gradient(var(--color-ink-600)_0_25%,transparent_0_50%,var(--color-ink-600)_0_75%,transparent_0)] bg-[length:8px_8px]"
      />
      {PRESET_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onPick(color)}
          title={t(`canvas.colors.${color}`)}
          aria-label={t(`canvas.colors.${color}`)}
          aria-pressed={current === color}
          className={'h-5 w-5 rounded-full border-2 ' + (current === color ? 'border-mist-100' : 'border-ink-850')}
          style={{ background: `var(--canvas-color-${color})` }}
        />
      ))}
    </span>
  )
}

/** Tools for a chosen line, in the middle of the canvas's top: label, both ends, colour, away. */
function EdgeTools({ edge, onLabel, onEnds, onColor, onRemove }: { edge: CanvasEdge; onLabel: () => void; onEnds: () => void; onColor: (color: string | undefined) => void; onRemove: () => void }) {
  const { t } = useTranslation()
  return (
    <div role="toolbar" aria-label={t('canvas.line')} className="absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-ink-600 bg-ink-850 p-1 shadow-xl">
      <Swatches current={edge.color} onPick={onColor} />
      <span className="mx-0.5 h-5 w-px bg-ink-600" />
      <button type="button" onClick={onLabel} className="rounded-lg px-2 py-1 text-sm text-mist-300 hover:bg-ink-700">
        {t('canvas.label')}
      </button>
      <button type="button" onClick={onEnds} aria-pressed={edge.fromEnd === 'arrow'} className="rounded-lg px-2 py-1 text-sm text-mist-300 hover:bg-ink-700">
        {t('canvas.bothEnds')}
      </button>
      <button type="button" onClick={onRemove} title={t('canvas.remove')} aria-label={t('canvas.remove')} className="rounded-lg px-2 py-1 text-bad-500 hover:bg-ink-700">
        <Symbol name="trash" className="h-4 w-4" />
      </button>
    </div>
  )
}

function ZoomBar({ undo, redo, canUndo, canRedo, snapping, setSnapping }: Omit<Props, 'canvas' | 'apply'>) {
  const { t } = useTranslation()
  const flow = useReactFlow()
  const { zoom } = useViewport()
  const cards = useCards()
  const button = 'grid h-8 min-w-8 place-items-center rounded-lg px-1 text-mist-300 hover:bg-ink-700 disabled:opacity-35'
  return (
    <div className="flex items-center gap-0.5 rounded-xl border border-ink-600 bg-ink-850 p-1 shadow-lg" role="toolbar" aria-label={t('canvas.view')}>
      <button type="button" className={button} onClick={() => void flow.zoomOut({ duration: 150 })} title={t('canvas.zoomOut')} aria-label={t('canvas.zoomOut')}>
        <Symbol name="minus" className="h-4 w-4" />
      </button>
      <span className="min-w-12 text-center text-xs text-mist-400 tabular-nums" aria-live="polite">
        {Math.round(zoom * 100)} %
      </span>
      <button type="button" className={button} onClick={() => void flow.zoomIn({ duration: 150 })} title={t('canvas.zoomIn')} aria-label={t('canvas.zoomIn')}>
        <Symbol name="plus" className="h-4 w-4" />
      </button>
      <button type="button" className={button} onClick={() => void flow.fitView({ padding: 0.15, duration: 200 })} title={t('canvas.fit')} aria-label={t('canvas.fit')}>
        <Symbol name="fit" className="h-4 w-4" />
      </button>
      {!cards.readonly && !cards.touch && (
        <>
          <span className="mx-0.5 h-5 w-px bg-ink-600" />
          <button type="button" className={button} onClick={undo} disabled={!canUndo} title={t('canvas.undo')} aria-label={t('canvas.undo')}>
            <Symbol name="undo" className="h-4 w-4" />
          </button>
          <button type="button" className={button} onClick={redo} disabled={!canRedo} title={t('canvas.redo')} aria-label={t('canvas.redo')}>
            <Symbol name="redo" className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={button + (snapping ? ' text-accent-400' : '')}
            onClick={() => setSnapping(!snapping)}
            aria-pressed={snapping}
            title={t('canvas.snapHint')}
            aria-label={t('canvas.snap')}
          >
            <Symbol name="magnet" className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  )
}

function Dock({ touch, add }: { touch: boolean; add: (kind: 'text' | 'note' | 'file' | 'link' | 'group' | 'fit') => void }) {
  const { t } = useTranslation()
  const items: { kind: 'text' | 'note' | 'file' | 'link' | 'group' | 'fit'; symbol: SymbolName }[] = touch
    ? [
        { kind: 'text', symbol: 'pencil' },
        { kind: 'note', symbol: 'note' },
        { kind: 'fit', symbol: 'fit' },
      ]
    : [
        { kind: 'text', symbol: 'pencil' },
        { kind: 'note', symbol: 'note' },
        { kind: 'file', symbol: 'image' },
        { kind: 'link', symbol: 'link' },
        { kind: 'group', symbol: 'columns' },
      ]
  return (
    <div className="flex gap-0.5 rounded-2xl border border-ink-600 bg-ink-850 p-1 shadow-2xl" role="toolbar" aria-label={t('canvas.add.label')}>
      {items.map((item) => (
        <button
          key={item.kind}
          type="button"
          onClick={() => add(item.kind)}
          className="flex min-w-14 flex-col items-center gap-0.5 rounded-xl px-2.5 py-1.5 text-[11px] text-mist-300 hover:bg-ink-700 hover:text-mist-100"
        >
          <Symbol name={item.symbol} className="h-[18px] w-[18px]" />
          {item.kind === 'fit' ? t('canvas.everything') : t(`canvas.add.${item.kind}Short`)}
        </button>
      ))}
    </div>
  )
}

/** The guides of a snap, drawn in screen pixels over the canvas. */
function Guides({ x, y }: { x: number[]; y: number[] }) {
  const flow = useReactFlow()
  const { x: shiftX, y: shiftY, zoom } = flow.getViewport()
  return (
    <>
      {x.map((value) => (
        <div key={`x${value}`} className="nl-guide nl-v" style={{ left: Math.round(value * zoom + shiftX) }} />
      ))}
      {y.map((value) => (
        <div key={`y${value}`} className="nl-guide nl-h" style={{ top: Math.round(value * zoom + shiftY) }} />
      ))}
    </>
  )
}
