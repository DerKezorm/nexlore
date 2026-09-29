/** The tags of the server's flat list as a tree, for the tag pane of the sidebar. */
import type { TagCount } from '../api/client'

export type TagNode = { name: string; tag: string; own: number; total: number; children: TagNode[] }

const fold = (text: string) => text.normalize('NFC').toLocaleLowerCase()

/** The flat list of the server as a tree, parts by "/", sorted by name; a part nobody writes alone still gets a node. */
export function tagTree(tags: TagCount[]): TagNode[] {
  const root: TagNode = { name: '', tag: '', own: 0, total: 0, children: [] }
  for (const { tag, count } of tags) {
    let node = root
    const parts = tag.split('/').filter(Boolean)
    parts.forEach((part, index) => {
      let child = node.children.find((other) => fold(other.name) === fold(part))
      if (!child) {
        child = { name: part, tag: node.tag ? node.tag + '/' + part : part, own: 0, total: 0, children: [] }
        node.children.push(child)
      }
      child.total += count
      if (index === parts.length - 1) child.own += count
      node = child
    })
  }
  const sort = (nodes: TagNode[]) => {
    nodes.sort((a, b) => fold(a.name).localeCompare(fold(b.name)))
    nodes.forEach((node) => sort(node.children))
  }
  sort(root.children)
  return root.children
}
