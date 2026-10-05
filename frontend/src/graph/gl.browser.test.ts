/**
 * The WebGL drawing in a real browser, read back pixel by pixel: what the shaders make of the zoom. A group is a red
 * circle of radius 50 around the middle, a blue note sits on its middle.
 */
import { BUBBLE_STRIDE, GraphGL, OPEN_FROM, OPEN_TO, POINT_STRIDE, dotRadius, type Colors } from './gl'

const SIZE = 200
const COLORS: Colors = { text: '#ffffff', dim: '#888888', bg: '#000000', edge: [0.5, 0.5, 0.5], accent: [0, 1, 0], light: false }

function setup() {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  canvas.style.width = `${SIZE}px`
  canvas.style.height = `${SIZE}px`
  document.body.appendChild(canvas)
  const gl = new GraphGL(canvas)
  // One circle: corners, middle, radius 50, parent radius 0 (always visible), red.
  const bubble = new ArrayBuffer(6 * BUBBLE_STRIDE)
  const bf = new Float32Array(bubble)
  const bu = new Uint8Array(bubble)
  const corners = [-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]
  for (let v = 0; v < 6; v++) {
    bf.set([corners[v * 2], corners[v * 2 + 1], 0, 0, 50, 0], (v * BUBBLE_STRIDE) / 4)
    // It opens by its own radius here (a group with many items).
    bf[(v * BUBBLE_STRIDE) / 4 + 7] = 50
    bu.set([255, 0, 0, 255], v * BUBBLE_STRIDE + 24)
  }
  gl.bubbles.upload(bubble, 6, new Uint8Array(24))
  // One note in the middle, radius 6, of a group of radius 50, blue.
  const point = new ArrayBuffer(POINT_STRIDE)
  new Float32Array(point).set([0, 0, 6, 50])
  new Uint8Array(point).set([0, 0, 255, 255], 16)
  gl.points.upload(point, 1, new Uint8Array(4))
  return { gl, canvas }
}

/** The colour in the middle of the drawing, right after drawing (before the browser puts it on screen). */
function middle(gl: GraphGL, k: number, right = 0): [number, number, number, number] {
  gl.render({ x: 0, y: 0, k }, SIZE, SIZE, 1, COLORS, 0)
  const pixel = new Uint8Array(4)
  gl.gl.readPixels(SIZE / 2 + right, SIZE / 2, 1, 1, gl.gl.RGBA, gl.gl.UNSIGNED_BYTE, pixel)
  return [pixel[0], pixel[1], pixel[2], pixel[3]]
}

describe('the graph in WebGL', () => {
  it('draws a closed group as a filled circle and hides its notes', () => {
    const { gl, canvas } = setup()
    // Radius on screen 50 * 1 = 50, below OPEN_FROM: closed.
    expect(50 * 1).toBeLessThan(OPEN_FROM)
    const [r, g, b, a] = middle(gl, 1)
    expect(a).toBeGreaterThan(20)
    expect(r).toBeGreaterThan(b)
    expect(g).toBeLessThan(10)
    gl.destroy()
    canvas.remove()
  })

  it('opens the group when it is big on screen: the note shows, the fill fades', () => {
    const { gl, canvas } = setup()
    // Radius on screen 50 * 4 = 200, above OPEN_TO: open.
    expect(50 * 4).toBeGreaterThan(OPEN_TO)
    const [r, , b, a] = middle(gl, 4)
    expect(a).toBeGreaterThan(200)
    expect(b).toBeGreaterThan(200)
    expect(r).toBeLessThan(40)
    gl.destroy()
    canvas.remove()
  })

  it('leaves out a note flagged hidden, and draws the focus with the accent', () => {
    const { gl, canvas } = setup()
    gl.points.setFlags(new Uint8Array([0, 0, 255, 0]))
    const [, , b] = middle(gl, 4)
    expect(b).toBeLessThan(40)
    // The focus keeps its colour and gets a ring in the accent around it (the dot, 6 at zoom 4, ends at dotRadius).
    gl.points.setFlags(new Uint8Array([0, 255, 0, 0]))
    const [, , inside] = middle(gl, 4)
    expect(inside).toBeGreaterThan(200)
    // A pixel is read at its middle, half a pixel further out than its index.
    const [r, g, b2] = middle(gl, 4, Math.round(dotRadius(6, 4, 50) + 3.5 - 0.5))
    expect(g).toBeGreaterThan(150)
    expect(r).toBeLessThan(40)
    expect(b2).toBeLessThan(90)
    gl.destroy()
    canvas.remove()
  })

  it('draws nothing of a circle whose parent is still closed', () => {
    const { gl, canvas } = setup()
    const bubble = new ArrayBuffer(6 * BUBBLE_STRIDE)
    const bf = new Float32Array(bubble)
    const bu = new Uint8Array(bubble)
    const corners = [-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]
    for (let v = 0; v < 6; v++) {
      // Parent radius 60: at zoom 1 the parent is 60 wide on screen, closed, so this child is not to be seen.
      bf.set([corners[v * 2], corners[v * 2 + 1], 0, 0, 50, 60], (v * BUBBLE_STRIDE) / 4)
      bf[(v * BUBBLE_STRIDE) / 4 + 7] = 50
      bu.set([255, 0, 0, 255], v * BUBBLE_STRIDE + 24)
    }
    gl.bubbles.upload(bubble, 6)
    gl.points.upload(new ArrayBuffer(0), 0)
    const [, , , a] = middle(gl, 1)
    expect(a).toBe(0)
    gl.destroy()
    canvas.remove()
  })
})
