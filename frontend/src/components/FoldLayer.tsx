/**
 * Folding in the reading view (`lib/folds.ts`): beside every heading of the note and every list item with items below
 * it a small arrow; folded, what follows the heading up to the next heading as high or higher is hidden, or the items
 * below the list item. The arrows are put into the drawn text after each drawing; the folds live in this browser.
 */
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'

import { FOLD_ALL_EVENT, FOLDS_EVENT, headingKind, itemKind, namer, readFolds, setFolds, toggleFold } from '../lib/folds'

const HEADING = /^H([1-6])$/

/** The words of a list item before the items below it. */
function itemText(item: Element): string {
  let text = ''
  for (const child of item.childNodes) {
    if (child.nodeName === 'UL' || child.nodeName === 'OL') break
    text += child.textContent ?? ''
  }
  return text
}

type Foldable = { element: HTMLElement; key: string; hides: HTMLElement[] }

/** What may be folded in the drawn note: its own headings (not those inside a callout or an embed) and list items. */
function foldables(root: HTMLElement): Foldable[] {
  const name = namer()
  const out: Foldable[] = []
  const children = [...root.children] as HTMLElement[]
  children.forEach((element, index) => {
    const found = HEADING.exec(element.tagName)
    if (!found) return
    const level = Number(found[1])
    const hides: HTMLElement[] = []
    for (const next of children.slice(index + 1)) {
      const other = HEADING.exec(next.tagName)
      if (other && Number(other[1]) <= level) break
      hides.push(next)
    }
    if (hides.length) out.push({ element, key: name(headingKind(level, element.textContent ?? '')), hides })
  })
  for (const item of root.querySelectorAll<HTMLElement>('li')) {
    if (item.closest('.nn-embedded')) continue
    const below = [...item.children].filter((child) => child.tagName === 'UL' || child.tagName === 'OL') as HTMLElement[]
    if (below.length) out.push({ element: item, key: name(itemKind(itemText(item))), hides: below })
  }
  return out
}

export function FoldLayer({ article, html, path }: { article: RefObject<HTMLElement | null>; html: string; path: string }) {
  const { t } = useTranslation()
  const [folds, setShown] = useState(() => readFolds(path))

  useEffect(() => {
    setShown(readFolds(path))
    const changed = (event: Event) => (event as CustomEvent<string>).detail === path && setShown(readFolds(path))
    const all = (event: Event) => {
      const { path: asked, fold } = (event as CustomEvent<{ path: string; fold: boolean }>).detail
      const root = article.current
      if (asked !== path || !root) return
      setFolds(path, fold ? foldables(root).map((item) => item.key) : [])
    }
    window.addEventListener(FOLDS_EVENT, changed)
    window.addEventListener(FOLD_ALL_EVENT, all)
    return () => {
      window.removeEventListener(FOLDS_EVENT, changed)
      window.removeEventListener(FOLD_ALL_EVENT, all)
    }
  }, [path, article])

  // After each drawing: the arrows in, the folded parts hidden.
  useLayoutEffect(() => {
    const root = article.current
    if (!root) return
    root.querySelectorAll('.nn-fold').forEach((button) => button.remove())
    root.querySelectorAll('.nn-folded').forEach((element) => element.classList.remove('nn-folded'))
    for (const { element, key, hides } of foldables(root)) {
      const folded = folds.has(key)
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'nn-fold'
      button.dataset.fold = key
      button.setAttribute('aria-expanded', String(!folded))
      button.setAttribute('aria-label', t(folded ? 'folds.unfold' : 'folds.fold', { name: (element.tagName === 'LI' ? itemText(element) : element.textContent ?? '').trim().slice(0, 60) }))
      element.classList.add('nn-foldable')
      element.prepend(button)
      if (folded) for (const hidden of hides) hidden.classList.add('nn-folded')
    }
  }, [article, html, folds, t])

  useEffect(() => {
    const root = article.current
    if (!root) return
    const click = (event: MouseEvent) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('.nn-fold')
      if (!button?.dataset.fold) return
      event.preventDefault()
      event.stopPropagation()
      toggleFold(path, button.dataset.fold)
    }
    root.addEventListener('click', click)
    return () => root.removeEventListener('click', click)
  }, [article, path])

  return null
}
