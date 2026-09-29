/**
 * The `base` code blocks of a note in the reading view: each holder the Markdown left (`lib/markdown.ts`) gets a view
 * over the notes of the note's space, as Obsidian shows a Bases block.
 */
import { useLayoutEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { BaseView } from './BaseView'

type Holder = { holder: HTMLElement; text: string; key: string }

export function BaseBlocks({ article, html, note }: { article: RefObject<HTMLElement | null>; html: string; note: string }) {
  const [holders, setHolders] = useState<Holder[]>([])
  useLayoutEffect(() => {
    const found: Holder[] = []
    article.current?.querySelectorAll<HTMLElement>('.nn-base[data-base]').forEach((holder, index) => {
      found.push({ holder, text: holder.dataset.base ?? '', key: `${index}` })
    })
    setHolders(found)
  }, [article, html])
  return <>{holders.map((item) => createPortal(<div className="not-prose my-4"><BaseView source={{ kind: 'block', note, text: item.text }} /></div>, item.holder, item.key))}</>
}
