/**
 * Tabs and groups of options made of buttons keep the promise of their roles (review before 1.0.0, P8.14): the arrows
 * move to the next one and choose it, Home and End to the first and last, and only the chosen one stands in the Tab
 * order, so Tab leaves the group in one step. Installed once for the whole app; it works on any
 * `role="tablist"` with `role="tab"` and any `role="radiogroup"` with `role="radio"` buttons (native radio inputs do
 * this by themselves).
 */
const GROUPS = [
  { group: '[role="tablist"]', item: '[role="tab"]', chosen: 'aria-selected' },
  { group: '[role="radiogroup"]', item: '[role="radio"]', chosen: 'aria-checked' },
] as const

function itemsOf(target: Element): { items: HTMLElement[]; chosen: string } | null {
  for (const kind of GROUPS) {
    const item = target.closest<HTMLElement>(kind.item)
    const group = item?.closest(kind.group)
    if (!item || !group) continue
    const items = [...group.querySelectorAll<HTMLElement>(kind.item)].filter(
      (each) => each.closest(kind.group) === group && !each.hasAttribute('disabled'),
    )
    return { items, chosen: kind.chosen }
  }
  return null
}

/** Only one in the Tab order: the one with the focus, else the chosen one, else the first. */
function rove(items: HTMLElement[], chosen: string): void {
  const focused = items.find((each) => each === document.activeElement)
  const picked = focused ?? items.find((each) => each.getAttribute(chosen) === 'true') ?? items[0]
  for (const each of items) each.tabIndex = each === picked ? 0 : -1
}

export function installRovingKeys(): () => void {
  const keys = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || !(event.target instanceof Element)) return
    const found = itemsOf(event.target)
    if (!found || found.items.length < 2) return
    const { items } = found
    const at = items.indexOf(event.target.closest<HTMLElement>('[role="tab"], [role="radio"]')!)
    let next = -1
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (at + 1) % items.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (at - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    if (next < 0) return
    event.preventDefault()
    items[next].focus()
    // Choosing follows the focus, as with radio buttons.
    items[next].click()
  }
  const entered = (event: FocusEvent) => {
    if (!(event.target instanceof Element)) return
    const found = itemsOf(event.target)
    if (found) rove(found.items, found.chosen)
  }
  document.addEventListener('keydown', keys)
  document.addEventListener('focusin', entered)
  return () => {
    document.removeEventListener('keydown', keys)
    document.removeEventListener('focusin', entered)
  }
}
