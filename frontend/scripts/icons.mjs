// The Lucide symbols (ISC licence, lucide-static) for spaces and folders: every element turned into a path, so the
// sidebar draws them as SVG and the map as Path2D alike, with the search words of each. Also the list of names the
// server accepts.
//
//   npm run icons            after a new lucide-static
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = path.join(HERE, '..', 'node_modules', 'lucide-static')
const nodes = JSON.parse(fs.readFileSync(path.join(SOURCE, 'icon-nodes.json'), 'utf-8'))
const tags = JSON.parse(fs.readFileSync(path.join(SOURCE, 'tags.json'), 'utf-8'))

const n = (value) => Number(value ?? 0)
const f = (value) => String(Math.round(value * 1000) / 1000)

/** One Lucide element (path, circle, ellipse, rect, line, polyline, polygon) as the `d` of a path. */
export function toPath(tag, a) {
  switch (tag) {
    case 'path':
      return a.d
    case 'circle':
    case 'ellipse': {
      const rx = n(a.rx ?? a.r)
      const ry = n(a.ry ?? a.r)
      const cx = n(a.cx)
      const cy = n(a.cy)
      return `M${f(cx - rx)} ${f(cy)}a${f(rx)} ${f(ry)} 0 1 0 ${f(2 * rx)} 0a${f(rx)} ${f(ry)} 0 1 0 ${f(-2 * rx)} 0`
    }
    case 'rect': {
      const x = n(a.x)
      const y = n(a.y)
      const w = n(a.width)
      const h = n(a.height)
      const rx = Math.min(n(a.rx ?? a.ry), w / 2)
      const ry = Math.min(n(a.ry ?? a.rx), h / 2)
      if (!rx && !ry) return `M${f(x)} ${f(y)}h${f(w)}v${f(h)}h${f(-w)}Z`
      return (
        `M${f(x + rx)} ${f(y)}h${f(w - 2 * rx)}a${f(rx)} ${f(ry)} 0 0 1 ${f(rx)} ${f(ry)}v${f(h - 2 * ry)}` +
        `a${f(rx)} ${f(ry)} 0 0 1 ${f(-rx)} ${f(ry)}h${f(-(w - 2 * rx))}a${f(rx)} ${f(ry)} 0 0 1 ${f(-rx)} ${f(-ry)}` +
        `v${f(-(h - 2 * ry))}a${f(rx)} ${f(ry)} 0 0 1 ${f(rx)} ${f(-ry)}Z`
      )
    }
    case 'line':
      return `M${f(n(a.x1))} ${f(n(a.y1))}L${f(n(a.x2))} ${f(n(a.y2))}`
    case 'polyline':
    case 'polygon': {
      const points = String(a.points).trim().split(/[\s,]+/).map(Number)
      let d = ''
      for (let i = 0; i + 1 < points.length; i += 2) d += `${i ? 'L' : 'M'}${f(points[i])} ${f(points[i + 1])}`
      return tag === 'polygon' ? d + 'Z' : d
    }
    default:
      throw new Error(`unknown element ${tag}`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const icons = {}
  for (const name of Object.keys(nodes).sort()) {
    icons[name] = { p: nodes[name].map(([tag, attrs]) => toPath(tag, attrs)), t: tags[name] ?? [] }
  }
  const out = path.join(HERE, '..', 'src', 'lib', 'lucide.json')
  fs.writeFileSync(out, JSON.stringify(icons) + '\n')
  const names = path.join(HERE, '..', '..', 'backend', 'app', 'services', 'lucide_names.txt')
  fs.writeFileSync(names, Object.keys(icons).join('\n') + '\n')
  // Their licence asks for its notice in every copy: it ships with the app.
  fs.mkdirSync(path.join(HERE, '..', 'public', 'licenses'), { recursive: true })
  fs.copyFileSync(path.join(SOURCE, 'LICENSE'), path.join(HERE, '..', 'public', 'licenses', 'lucide.txt'))
  console.log(Object.keys(icons).length, 'symbols,', Math.round(fs.statSync(out).size / 1024), 'KB')
}
