/**
 * The view of a list item: Milkdown's own (`@milkdown/components/list-item-block`, 7.22.2, MIT), with one change.
 *
 * Mounted, Milkdown's moved the content into its frame and, a frame later, set the selection back to where it was at
 * mounting. Typed fast after Enter (a macro, dictation: a few milliseconds between keys), that place was already
 * old: the next letter went to the end of the note and the list grew empty items (review before 1.0.0, PG-106). And
 * every list item dispatched once, which made a note full of lists slow to open (PG-107). Here the selection is set
 * back only when nothing happened since, and the item is focused.
 */
import { listItemSchema } from '@milkdown/kit/preset/commonmark'
import { ListItem, listItemBlockConfig } from '@milkdown/kit/component/list-item-block'
import type { Node } from '@milkdown/kit/prose/model'
import { TextSelection } from '@milkdown/kit/prose/state'
import { $view } from '@milkdown/kit/utils'
import { createApp, ref, watchEffect } from 'vue'

export const listItemView = $view(listItemSchema.node, (ctx) => {
  return (initialNode, view, getPos) => {
    const dom = document.createElement('div')
    dom.className = 'milkdown-list-item-block'
    const contentDOM = document.createElement('div')
    contentDOM.setAttribute('data-content-dom', 'true')
    contentDOM.classList.add('content-dom')
    const label = ref(initialNode.attrs.label)
    const checked = ref(initialNode.attrs.checked)
    const listType = ref(initialNode.attrs.listType)
    const readonly = ref(!view.editable)
    const config = ctx.get(listItemBlockConfig.key)
    const selected = ref(false)
    const setAttr = (attr: string, value: unknown) => {
      if (!view.editable) return
      const pos = getPos()
      if (pos == null) return
      if (!view.hasFocus()) view.focus()
      view.dispatch(view.state.tr.setNodeAttribute(pos, attr, value))
    }
    const disposeSelectedWatcher = watchEffect(() => {
      if (selected.value) dom.classList.add('selected')
      else dom.classList.remove('selected')
    })
    let raf = 0
    let mountedDiv: HTMLElement | null = null
    const onMount = (div: HTMLElement) => {
      if (div === mountedDiv) return
      mountedDiv = div
      const before = view.state
      div.appendChild(contentDOM)
      raf = requestAnimationFrame(() => {
        raf = 0
        if (view.isDestroyed) return
        // Whatever came since (typing, another item set back already) knows the selection better than this frame.
        if (view.state !== before || !view.hasFocus()) return
        const { anchor, head } = before.selection
        view.dispatch(view.state.tr.setSelection(TextSelection.between(view.state.doc.resolve(anchor), view.state.doc.resolve(head))))
      })
    }
    const app = createApp(ListItem, { label, checked, listType, readonly, config, selected, setAttr, onMount })
    app.mount(dom)
    const bindAttrs = (node: Node) => {
      listType.value = node.attrs.listType
      label.value = node.attrs.label
      checked.value = node.attrs.checked
      readonly.value = !view.editable
    }
    bindAttrs(initialNode)
    let node = initialNode
    return {
      dom,
      contentDOM,
      update: (updatedNode: Node) => {
        if (updatedNode.type !== initialNode.type) return false
        if (updatedNode.sameMarkup(node) && updatedNode.content.eq(node.content)) return true
        node = updatedNode
        bindAttrs(updatedNode)
        return true
      },
      ignoreMutation: (mutation: MutationRecord | { type: 'selection'; target: globalThis.Node }) => {
        if (!dom || !contentDOM) return true
        if (mutation.type === 'selection') return false
        if (contentDOM === mutation.target && mutation.type === 'attributes') return true
        if (contentDOM.contains(mutation.target)) return false
        return true
      },
      selectNode: () => {
        selected.value = true
      },
      deselectNode: () => {
        selected.value = false
      },
      destroy: () => {
        cancelAnimationFrame(raf)
        disposeSelectedWatcher()
        app.unmount()
        dom.remove()
        contentDOM.remove()
      },
    }
  }
})
