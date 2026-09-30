/**
 * Crepe's slash menu has no roles for screen readers (review before 1.0.0, P3.22): its entries are plain list items,
 * and the text says nothing about an open menu. Here the menu becomes a listbox with options while it shows, the
 * chosen entry is `aria-selected`, and the text names it as its active descendant with `aria-expanded`.
 */
export function describeSlashMenu(root: HTMLElement, text: HTMLElement, label: string): () => void {
  let frame = 0
  const update = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      const menu = root.querySelector<HTMLElement>('.milkdown-slash-menu')
      const open = !!menu && menu.dataset.show !== 'false' && getComputedStyle(menu).display !== 'none'
      text.setAttribute('aria-expanded', String(open))
      if (!menu || !open) return text.removeAttribute('aria-activedescendant')
      const groups = menu.querySelector<HTMLElement>('.menu-groups')
      groups?.setAttribute('role', 'listbox')
      groups?.setAttribute('aria-label', label)
      if (groups?.id !== 'nx-slash-menu') groups?.setAttribute('id', 'nx-slash-menu')
      text.setAttribute('aria-controls', 'nx-slash-menu')
      let active = ''
      for (const item of menu.querySelectorAll<HTMLElement>('li[data-index]')) {
        const id = `nx-slash-${item.dataset.index}`
        if (item.id !== id) item.id = id
        item.setAttribute('role', 'option')
        // Crepe marks the entry the arrows are on with `hover`.
        const selected = item.classList.contains('hover')
        item.setAttribute('aria-selected', String(selected))
        if (selected) active = id
      }
      for (const list of menu.querySelectorAll<HTMLElement>('.menu-group ul')) list.setAttribute('role', 'presentation')
      if (active) text.setAttribute('aria-activedescendant', active)
      else text.removeAttribute('aria-activedescendant')
    })
  }
  const watch = new MutationObserver(update)
  watch.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'data-show', 'style'] })
  return () => {
    watch.disconnect()
    cancelAnimationFrame(frame)
  }
}
