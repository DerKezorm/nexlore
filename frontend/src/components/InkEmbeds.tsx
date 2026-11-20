/**
 * Drawings embedded in a note (`![[Sketch.svg]]`), in the reading view and in the editor: `renderMarkdown` and
 * `editor/live.ts` leave a holder with the SVG's path; each holder gets the drawing's block from here (`ink/`,
 * loaded only when a note has one). An SVG that is no drawing gets its link back.
 */
import { Suspense, lazy, useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'

const InkBlock = lazy(() => import('../ink/InkBlock'))

/** More drawings than this in one note stay links: each one asks the server for its state every few seconds. */
export const MAX_INK_EMBEDS = 12

type Holder = { holder: HTMLElement; path: string; text: string }

/** The holders in `root` as they are now (`selector`: the reading view's or the editor's). */
function holdersIn(root: HTMLElement, selector: string): Holder[] {
  return [...root.querySelectorAll<HTMLElement>(selector)].slice(0, MAX_INK_EMBEDS).map((holder) => ({
    holder,
    path: holder.dataset.ink!,
    text: holder.dataset.text ?? holder.textContent?.trim() ?? holder.dataset.ink!.split('/').pop()!,
  }))
}

function Blocks({ holders }: { holders: Holder[] }) {
  const navigate = useNavigate()
  return (
    <>
      {holders.map((item, index) =>
        createPortal(
          <Suspense fallback={null}>
            <InkBlock path={item.path} text={item.text} onOpen={(route) => navigate(route)} />
          </Suspense>,
          item.holder,
          `ink:${index}:${item.path}`,
        ),
      )}
    </>
  )
}

/** In the reading view: the holders of the rendered note, found again whenever its HTML changes. */
export function InkEmbeds({ article, html }: { article: RefObject<HTMLElement | null>; html: string }) {
  const [holders, setHolders] = useState<Holder[]>([])
  useLayoutEffect(() => {
    const root = article.current
    if (!root) return setHolders([])
    const found = holdersIn(root, '.nn-embed-ink[data-ink]')
    for (const item of found) {
      // The link's words are kept for an SVG that turns out to be no drawing.
      item.holder.dataset.text = item.text
      item.holder.replaceChildren()
    }
    setHolders(found)
  }, [article, html])
  return <Blocks holders={holders} />
}

/**
 * In the editor: holders come and go as ProseMirror draws its decorations (the cursor going into the link takes the
 * holder, and the block with it).
 */
export function InkWidgets({ host }: { host: RefObject<HTMLElement | null> }) {
  const [holders, setHolders] = useState<Holder[]>([])
  useEffect(() => {
    const root = host.current
    if (!root) return
    const look = () => {
      const found = holdersIn(root, '.nx-embed-ink[data-ink]')
      setHolders((before) => (before.length === found.length && before.every((item, at) => item.holder === found[at].holder) ? before : found))
    }
    look()
    // Only holders coming and going count; what changes inside a block is its own business.
    const watcher = new MutationObserver((changes) => {
      if (changes.some((change) => [...change.addedNodes, ...change.removedNodes].some((node) => node instanceof HTMLElement && (node.matches('.nx-embed-ink') || !!node.querySelector('.nx-embed-ink'))))) look()
    })
    watcher.observe(root, { childList: true, subtree: true })
    return () => watcher.disconnect()
  }, [host])
  return <Blocks holders={holders} />
}
