/**
 * Drawn cover pictures for the cover flow: a handful of motifs (mountains, dunes, silk, forest, blossom, city,
 * northern lights, sea) in any hue, drawn as SVG and turned into a picture in the browser. What is stored is that
 * picture (`/api/cover`), never the SVG: the server keeps covers as pictures only, whatever they came from.
 *
 * The same name and hue draw the same picture (a seeded random), so the preview in the dialog is what is kept.
 */

export const MOTIFS = ['mountains', 'dunes', 'waves', 'forest', 'blossom', 'city', 'aurora', 'sea'] as const
export type Motif = (typeof MOTIFS)[number]

/** The size the server keeps covers in (`services/covers.py`): three by four. */
export const COVER_WIDTH = 900
export const COVER_HEIGHT = 1200

function seeded(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function seedOf(text: string): number {
  let hash = 2166136261
  for (const char of text) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

const c = (h: number, s: number, l: number, a = 1) => `hsla(${((h % 360) + 360) % 360},${s}%,${l}%,${a})`
const n = (value: number) => value.toFixed(0)

function grad(id: string, a: string, b: string, end?: string): string {
  const stops = end ? `<stop offset=".6" stop-color="${b}"/><stop offset="1" stop-color="${end}"/>` : `<stop offset="1" stop-color="${b}"/>`
  return `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/>${stops}</linearGradient>`
}

const DRAW: Record<Motif, (h: number, r: () => number) => string> = {
  mountains(h, r) {
    let s = `<defs>${grad('g', c(h + 10, 45, 18), c(h - 10, 55, 58), c(h - 25, 60, 80))}</defs><rect width="300" height="400" fill="url(#g)"/>`
    s += `<circle cx="${n(60 + r() * 180)}" cy="${n(105 + r() * 40)}" r="${n(20 + r() * 14)}" fill="${c(h + 40, 90, 93, 0.85)}"/>`
    for (let i = 0; i < 4; i++) {
      const base = 190 + i * 58
      let d = `M0 400L0 ${base}`
      let x = 0
      while (x < 300) {
        x += 18 + r() * 40
        d += `L${n(x)} ${n(base - (40 + r() * 110) * (1 - i * 0.18))}`
        x += 10 + r() * 30
        d += `L${n(x)} ${n(base - r() * 30)}`
      }
      s += `<path d="${d}L300 400Z" fill="${c(h + 5, 22 + i * 6, 70 - i * 15)}"/>`
    }
    return s
  },
  dunes(h, r) {
    let s = `<defs>${grad('g', c(h + 15, 70, 84), c(h, 65, 66))}</defs><rect width="300" height="400" fill="url(#g)"/>`
    s += `<circle cx="${n(80 + r() * 140)}" cy="${n(110 + r() * 30)}" r="26" fill="${c(h + 30, 95, 96, 0.9)}"/>`
    for (let i = 0; i < 5; i++) {
      const y = 190 + i * 45
      let d = `M0 400L0 ${y}`
      let x = 0
      while (x < 320) {
        const nx = x + 80 + r() * 90
        const ny = y + r() * 30 - 15
        d += `Q${n((x + nx) / 2 + r() * 30 - 15)} ${n(ny - 40 - r() * 45)} ${n(nx)} ${n(ny)}`
        x = nx
      }
      s += `<path d="${d}L320 400L0 400Z" fill="${c(h - i * 3, 50 + i * 4, 66 - i * 9)}"/>`
    }
    return s
  },
  waves(h, r) {
    let s = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c(h, 45, 14)}"/><stop offset="1" stop-color="${c(h + 40, 45, 34)}"/></linearGradient><filter id="b"><feGaussianBlur stdDeviation="2.5"/></filter></defs><rect width="300" height="400" fill="url(#g)"/>`
    for (let i = 0; i < 9; i++) {
      const y = 50 + i * 38 + r() * 20
      const a = 40 + r() * 70
      const t = 16 + r() * 34
      s += `<path filter="url(#b)" d="M-40 ${n(y)}C80 ${n(y - a)} 200 ${n(y + a)} 340 ${n(y - a * 0.4)}L340 ${n(y - a * 0.4 + t)}C200 ${n(y + a + t)} 80 ${n(y - a + t)} -40 ${n(y + t)}Z" fill="${c(h + 20 + i * 7, 70, 74 + r() * 14, 0.16 + r() * 0.32)}"/>`
    }
    return s
  },
  forest(h, r) {
    let s = `<defs>${grad('g', c(h + 70, 40, 86), c(h + 40, 40, 70))}</defs><rect width="300" height="400" fill="url(#g)"/>`
    s += `<circle cx="${n(200 + r() * 60)}" cy="90" r="22" fill="${c(h + 60, 90, 95, 0.9)}"/>`
    for (let i = 0; i < 4; i++) {
      const base = 200 + i * 52
      const colour = c(h, 30 + i * 4, 52 - i * 12)
      const hill = (x: number) => base + Math.sin(x / 50 + i * 2) * 12
      let d = 'M0 400'
      for (let x = 0; x <= 300; x += 20) d += `L${x} ${n(hill(x))}`
      s += `<path d="${d}L300 400Z" fill="${colour}"/>`
      for (let x = -5; x < 310; x += 12 + r() * 14) {
        const y = hill(x) + 4
        const height = 30 + r() * 40 + i * 6
        const w = 8 + r() * 5 + i
        s += `<path d="M${n(x)} ${n(y - height)}L${n(x - w)} ${n(y)}L${n(x + w)} ${n(y)}Z" fill="${colour}"/>`
      }
    }
    return s
  },
  blossom(h, r) {
    let s = `<defs>${grad('g', c(h, 60, 92), c(h + 25, 50, 78))}</defs><rect width="300" height="400" fill="url(#g)"/>`
    s += `<path d="M0 330L70 250L120 290L190 210L260 280L300 250L300 400L0 400Z" fill="${c(h + 200, 15, 78)}"/><path d="M0 360L90 320L170 350L240 315L300 340L300 400L0 400Z" fill="${c(h + 190, 18, 68)}"/>`
    const branch = [[320, 40], [250, 85], [180, 110], [120, 160], [60, 190], [20, 230]]
    s += `<path d="M${branch.map((p) => p.join(' ')).join('L')}" stroke="${c(20, 25, 25)}" stroke-width="7" fill="none" stroke-linecap="round"/>`
    s += `<path d="M180 110L200 160L215 190M120 160L110 210M250 85L230 40" stroke="${c(20, 25, 28)}" stroke-width="3.5" fill="none" stroke-linecap="round"/>`
    const near = [...branch, [210, 190], [110, 210], [230, 40], [200, 160]]
    for (let k = 0; k < 110; k++) {
      const p = near[Math.floor(r() * near.length)]
      s += `<circle cx="${n(p[0] + (r() - 0.5) * 70)}" cy="${n(p[1] + (r() - 0.5) * 60)}" r="${(2.5 + r() * 6).toFixed(1)}" fill="${c(h + r() * 20 - 10, 70, 76 + r() * 16, 0.92)}"/>`
    }
    return s
  },
  city(h, r) {
    let s = `<defs>${grad('g', c(h, 50, 9), c(h + 25, 55, 32))}</defs><rect width="300" height="400" fill="url(#g)"/>`
    for (let k = 0; k < 40; k++) s += `<circle cx="${n(r() * 300)}" cy="${n(r() * 200)}" r="${(r() * 1.1 + 0.3).toFixed(1)}" fill="#fff" opacity="${(r() * 0.7 + 0.2).toFixed(2)}"/>`
    s += `<circle cx="${n(60 + r() * 180)}" cy="70" r="16" fill="${c(h + 40, 60, 92)}"/>`
    for (let layer = 0; layer < 2; layer++) {
      let x = -10
      while (x < 300) {
        const w = 20 + r() * 28
        const height = (layer ? 90 : 150) + r() * (layer ? 120 : 110)
        const y = 400 - height
        s += `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(height)}" fill="${c(h, 30, layer ? 9 : 16)}"/>`
        if (layer) {
          for (let wy = y + 8; wy < 395; wy += 9) {
            for (let wx = x + 4; wx < x + w - 4; wx += 7) if (r() < 0.3) s += `<rect x="${n(wx)}" y="${n(wy)}" width="3" height="4" fill="${c(45, 95, 72, 0.85)}"/>`
          }
        }
        x += w + 2
      }
    }
    return s
  },
  aurora(h, r) {
    let s = `<defs>${grad('g', c(h + 60, 60, 5), c(h, 50, 20))}<filter id="b"><feGaussianBlur stdDeviation="9"/></filter></defs><rect width="300" height="400" fill="url(#g)"/>`
    for (let k = 0; k < 70; k++) s += `<circle cx="${n(r() * 300)}" cy="${n(r() * 300)}" r="${(r() * 1.1 + 0.3).toFixed(1)}" fill="#fff" opacity="${(r() * 0.7 + 0.2).toFixed(2)}"/>`
    for (let i = 0; i < 4; i++) {
      const y = 90 + i * 35 + r() * 30
      s += `<path filter="url(#b)" d="M-20 ${n(y + 60)}C70 ${n(y - 40 - r() * 60)} 190 ${n(y + 90)} 320 ${n(y - 20)}" stroke="${c(h + i * 25, 85, 62, 0.5)}" stroke-width="${n(26 + r() * 30)}" fill="none"/>`
    }
    s += `<path d="M0 330L50 300L90 315L150 270L210 310L260 290L300 305L300 400L0 400Z" fill="${c(h, 30, 6)}"/>`
    return s
  },
  sea(h, r) {
    let s = `<defs>${grad('g', c(h + 10, 60, 35), c(h + 40, 80, 72), c(h + 55, 90, 84))}${grad('w', c(h, 45, 32), c(h - 10, 55, 10))}</defs><rect width="300" height="260" fill="url(#g)"/>`
    s += `<circle cx="150" cy="255" r="40" fill="${c(h + 55, 95, 90)}"/><rect y="255" width="300" height="145" fill="url(#w)"/>`
    for (let k = 0; k < 26; k++) {
      const y = 260 + k * 5 + r() * 3
      const w = 70 - k * 2 + r() * 20
      s += `<rect x="${n(150 - w / 2 + (r() - 0.5) * 20)}" y="${n(y)}" width="${n(w)}" height="1.6" fill="${c(h + 55, 95, 88, 0.55 - k * 0.015)}"/>`
    }
    return s
  },
}

/** The motif as an SVG document, three by four. */
export function motifSvg(motif: Motif, hue: number, seed: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${COVER_WIDTH}" height="${COVER_HEIGHT}" viewBox="0 0 300 400" preserveAspectRatio="xMidYMid slice">${DRAW[motif](hue, seeded(seed))}</svg>`
}

/** The motif as an address for an `<img>` or a background; single quotes, so it may stand in a style attribute. */
export function motifUrl(motif: Motif, hue: number, seed: number): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(motifSvg(motif, hue, seed))}`
}

/** The motif drawn as a PNG of the cover's size, to be sent as the cover. */
export async function motifPicture(motif: Motif, hue: number, seed: number): Promise<Blob> {
  const image = new Image()
  image.src = motifUrl(motif, hue, seed)
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = COVER_WIDTH
  canvas.height = COVER_HEIGHT
  const context = canvas.getContext('2d')
  if (!context) throw new Error('no canvas')
  context.drawImage(image, 0, 0, COVER_WIDTH, COVER_HEIGHT)
  return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('no picture'))), 'image/png'))
}
