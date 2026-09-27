/**
 * The graph drawn with WebGL2. Measured against sigma.js, AntV G6 and PixiJS (tools/graph-vergleich): with 100,000
 * notes whose opacity follows the zoom, this way stays above 30 frames a second even without a graphics card.
 *
 * Everything that changes with the zoom is worked out in the shaders from the camera: how open a group is depends only
 * on its radius on screen (radius times zoom), so each note carries the radius of its group, each circle its own and
 * its parent's, and the CPU does nothing per frame but set four numbers. Notes are points (one vertex each; software
 * rendering is fifty times slower with instancing), circles and thick lines are quads, thin lines are GL lines.
 *
 * The same rules as in the attrappe (`OPEN_FROM`, `OPEN_TO`, shell, ring, inner) and as the server's `OPEN_FROM`.
 */

export const OPEN_FROM = 80
export const OPEN_TO = 170
/** Dots stop growing at this radius on screen, otherwise deep zoom turns them into discs. */
export const MAX_DOT = 15
export const MIN_DOT = 2

export type Camera = { x: number; y: number; k: number }

/** Colours of the page, read from the theme: `[r, g, b]` from 0 to 1. */
export type Colors = { text: string; dim: string; bg: string; edge: [number, number, number]; accent: [number, number, number]; light: boolean }

const COMMON = `
uniform vec3 cam;      // x, y, zoom
uniform vec2 size;     // CSS pixels
uniform float dpr;
float ease(float a, float b, float v) { float t = clamp((v - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float openness(float r) { return r <= 0.0 ? 1.0 : ease(${OPEN_FROM.toFixed(1)}, ${OPEN_TO.toFixed(1)}, r * cam.z); }
float shell(float o) { return 1.0 - ease(0.15, 0.75, o); }
float ring(float o) { return ease(0.1, 0.5, o); }
float inner(float o) { return ease(0.1, 0.6, o); }
vec2 toScreen(vec2 p) { return (p - cam.xy) * cam.z + size * 0.5; }
vec4 toClip(vec2 s) { return vec4(s / size * 2.0 - 1.0, 0.0, 1.0) * vec4(1.0, -1.0, 1.0, 1.0); }
// How visible an end of a line is: a note (kind 0) with its group's radius, or a closed circle (kind 1).
float endAlpha(float kind, float r, float rp) {
  return kind < 0.5 ? inner(openness(r)) : shell(openness(r)) * inner(openness(rp));
}
`

const POINT_VS = `#version 300 es
in vec2 pos; in float rad; in float home; in vec4 col; in vec4 flag;
${COMMON}
uniform float focusOn;
out vec4 vColor; out float vPix; out float vRing;
void main() {
  float a = inner(openness(home)) * col.a;
  if (flag.z > 0.5) a = 0.0;                       // hidden (daily notes switched off)
  if (focusOn > 0.5 && flag.w < 0.5 && flag.y < 0.5) a *= 0.25;   // not the focus and not next to it
  float r = clamp(rad * cam.z, ${MIN_DOT.toFixed(1)}, ${MAX_DOT.toFixed(1)});
  vRing = flag.y > 0.5 ? 1.0 : 0.0;
  vColor = vec4(col.rgb, a);
  float outer = r + (vRing > 0.5 ? 6.0 : 1.0);
  vPix = r;
  gl_PointSize = 2.0 * outer * dpr;
  gl_Position = toClip(toScreen(pos));
  if (a < 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`

const POINT_FS = `#version 300 es
precision mediump float;
in vec4 vColor; in float vPix; in float vRing;
uniform vec3 accent; uniform float dpr;
out vec4 o;
void main() {
  float outer = vPix + (vRing > 0.5 ? 6.0 : 1.0);
  float d = length(gl_PointCoord * 2.0 - 1.0) * outer;     // CSS pixels from the middle
  float fill = clamp(vPix - d + 0.5, 0.0, 1.0);
  vec3 c = vRing > 0.5 ? accent : vColor.rgb;
  float a = fill;
  if (vRing > 0.5) {
    float band = clamp(1.2 - abs(d - (vPix + 3.5)), 0.0, 1.0);
    a = max(fill, band);
  }
  a *= vColor.a;
  if (a <= 0.003) discard;
  o = vec4(c * a, a);
}`

const BUBBLE_VS = `#version 300 es
in vec2 corner; in vec3 circle; in float parentR; in vec4 col; in vec4 flag;
${COMMON}
uniform float focusOn;
out vec2 vLocal; out float vR; out float vShell; out float vRing; out vec4 vColor; out vec4 vFlag;
void main() {
  float o = openness(circle.z);
  float vis = inner(openness(parentR));
  vShell = shell(o) * vis;
  vRing = ring(o) * vis;
  if (flag.w > 0.5) { vShell = 0.0; vRing = 0.0; }   // hidden
  vColor = col; vFlag = flag;
  vR = circle.z * cam.z;
  vec2 c = toScreen(circle.xy);
  vLocal = corner * (vR + 2.0);
  gl_Position = toClip(c + vLocal);
  bool off = c.x + vR < 0.0 || c.x - vR > size.x || c.y + vR < 0.0 || c.y - vR > size.y;
  if ((vShell < 0.01 && vRing < 0.01) || off) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`

const BUBBLE_FS = `#version 300 es
precision mediump float;
in vec2 vLocal; in float vR; in float vShell; in float vRing; in vec4 vColor; in vec4 vFlag;
uniform float focusOn; uniform float light; uniform vec3 accent;
out vec4 o;
void main() {
  float d = length(vLocal);
  float inside = clamp(vR - d + 0.5, 0.0, 1.0);
  float hover = vFlag.x;
  float marked = vFlag.y;
  float dashed = vFlag.z;
  float dim = (focusOn > 0.5 && marked < 0.5) ? 0.5 : 1.0;
  // Closed: a filled bubble with a border. Open: a faint area with a thin (for folders below a space: dashed) border.
  float fillA = vShell * (hover > 0.5 ? 0.3 : 0.18) * dim + vRing * (light > 0.5 ? 0.05 : 0.035);
  float edgeWidth = marked > 0.5 && focusOn > 0.5 ? 2.5 : 1.5;
  float edge = clamp(1.0 - abs(d - vR + edgeWidth * 0.5) / (edgeWidth * 0.5 + 0.5), 0.0, 1.0);
  float dash = 1.0;
  if (dashed > 0.5 && vRing > 0.01) {
    float along = atan(vLocal.y, vLocal.x) * vR;
    dash = step(fract(along / 9.0), 0.45);
  }
  float edgeA = vShell * (hover > 0.5 ? 0.9 : 0.6) + vRing * (dashed > 0.5 ? 0.28 : 0.35) * dash;
  vec3 edgeColor = (marked > 0.5 && focusOn > 0.5 && vShell > 0.01) ? accent : vColor.rgb;
  float a1 = fillA * inside;
  float a2 = edgeA * edge;
  vec3 rgb = vColor.rgb * a1 * (1.0 - a2) + edgeColor * a2;
  float a = a1 * (1.0 - a2) + a2;
  if (a <= 0.003) discard;
  o = vec4(rgb, a);
}`

const LINE_VS = `#version 300 es
in vec2 pos; in vec3 self; in vec3 other;   // kind, radius, parent radius of this end and of the other
${COMMON}
uniform float focusOn;
out float vA;
void main() {
  vA = min(endAlpha(self.x, self.y, self.z), endAlpha(other.x, other.y, other.z)) * (focusOn > 0.5 ? 0.08 : 0.22);
  gl_Position = toClip(toScreen(pos));
}`

const LINE_FS = `#version 300 es
precision mediump float;
in float vA; uniform vec3 edge; out vec4 o;
void main() { if (vA <= 0.003) discard; o = vec4(edge * vA, vA); }`

// Thick lines: bundles between closed circles, and the lines of the focused note. From edge to edge of the circles.
const BAND_VS = `#version 300 es
in vec2 corner; in vec4 ends; in vec3 aEnd; in vec3 bEnd; in vec2 style;   // style: width, hot
${COMMON}
uniform float focusOn;
out float vA; out float vHot; out float vAcross;
void main() {
  vec2 a = toScreen(ends.xy);
  vec2 b = toScreen(ends.zw);
  float ra = aEnd.x < 0.5 ? 0.0 : aEnd.y * cam.z;
  float rb = bEnd.x < 0.5 ? 0.0 : bEnd.y * cam.z;
  vec2 d = b - a;
  float len = length(d);
  vHot = style.y;
  float base = min(endAlpha(aEnd.x, aEnd.y, aEnd.z), endAlpha(bEnd.x, bEnd.y, bEnd.z));
  vA = base * (vHot > 0.5 ? 0.9 : (focusOn > 0.5 ? 0.1 : 0.28));
  vAcross = corner.y;
  if (len < ra + rb + 1.0) { vA = 0.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 u = d / len;
  vec2 n = vec2(-u.y, u.x);
  vec2 p = mix(a + u * ra, b - u * rb, corner.x) + n * corner.y * (style.x * 0.5 + 0.75);
  gl_Position = toClip(p);
}`

const BAND_FS = `#version 300 es
precision mediump float;
in float vA; in float vHot; in float vAcross; uniform vec3 edge; uniform vec3 accent; out vec4 o;
void main() {
  float a = vA * clamp((1.0 - abs(vAcross)) * 3.0, 0.0, 1.0);
  if (a <= 0.003) discard;
  vec3 c = vHot > 0.5 ? accent : edge;
  o = vec4(c * a, a);
}`

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram()!
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader')
    gl.attachShader(program, shader)
  }
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link')
  return program
}

type Attr = { name: string; size: number; type: number; offset: number; normalized?: boolean }

class Layer {
  vao: WebGLVertexArrayObject
  buffer: WebGLBuffer
  flags: WebGLBuffer | null = null
  count = 0

  constructor(
    private gl: WebGL2RenderingContext,
    public program: WebGLProgram,
    stride: number,
    attrs: Attr[],
    flagAttr?: string,
  ) {
    this.vao = gl.createVertexArray()!
    this.buffer = gl.createBuffer()!
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    for (const attr of attrs) {
      const location = gl.getAttribLocation(program, attr.name)
      if (location < 0) continue
      gl.enableVertexAttribArray(location)
      gl.vertexAttribPointer(location, attr.size, attr.type, attr.normalized ?? false, stride, attr.offset)
    }
    if (flagAttr) {
      this.flags = gl.createBuffer()!
      gl.bindBuffer(gl.ARRAY_BUFFER, this.flags)
      const location = gl.getAttribLocation(program, flagAttr)
      if (location >= 0) {
        gl.enableVertexAttribArray(location)
        gl.vertexAttribPointer(location, 4, gl.UNSIGNED_BYTE, true, 4, 0)
      }
    }
    gl.bindVertexArray(null)
  }

  upload(data: ArrayBuffer, count: number, flags?: Uint8Array) {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
    this.count = count
    if (flags) this.setFlags(flags)
  }

  setFlags(flags: Uint8Array) {
    if (!this.flags) return
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flags)
    gl.bufferData(gl.ARRAY_BUFFER, flags, gl.DYNAMIC_DRAW)
  }

  destroy() {
    this.gl.deleteBuffer(this.buffer)
    if (this.flags) this.gl.deleteBuffer(this.flags)
    this.gl.deleteVertexArray(this.vao)
  }
}

/** Bytes per vertex of each layer; `scene.ts` fills buffers in exactly this layout. */
export const POINT_STRIDE = 24 // x, y, r, home (f32) + rgba (u8)
export const BUBBLE_STRIDE = 32 // corner x, y, circle x, y, r, parent r (f32) + rgba (u8) + 4 spare bytes
export const LINE_STRIDE = 32 // x, y, self kind, r, rp, other kind, r, rp (f32)
export const BAND_STRIDE = 64 // corner x, y, a x, y, b x, y, a kind, r, rp, b kind, r, rp, width, hot (f32) + 8 spare

export class GraphGL {
  readonly gl: WebGL2RenderingContext
  readonly points: Layer
  readonly bubbles: Layer
  readonly lines: Layer
  readonly bands: Layer
  private programs: WebGLProgram[]

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: true, alpha: true })
    if (!gl) throw new Error('webgl2')
    this.gl = gl
    const F = gl.FLOAT
    const U = gl.UNSIGNED_BYTE
    const points = compile(gl, POINT_VS, POINT_FS)
    const bubbles = compile(gl, BUBBLE_VS, BUBBLE_FS)
    const lines = compile(gl, LINE_VS, LINE_FS)
    const bands = compile(gl, BAND_VS, BAND_FS)
    this.programs = [points, bubbles, lines, bands]
    this.points = new Layer(gl, points, POINT_STRIDE, [
      { name: 'pos', size: 2, type: F, offset: 0 },
      { name: 'rad', size: 1, type: F, offset: 8 },
      { name: 'home', size: 1, type: F, offset: 12 },
      { name: 'col', size: 4, type: U, offset: 16, normalized: true },
    ], 'flag')
    this.bubbles = new Layer(gl, bubbles, BUBBLE_STRIDE, [
      { name: 'corner', size: 2, type: F, offset: 0 },
      { name: 'circle', size: 3, type: F, offset: 8 },
      { name: 'parentR', size: 1, type: F, offset: 20 },
      { name: 'col', size: 4, type: U, offset: 24, normalized: true },
    ], 'flag')
    this.lines = new Layer(gl, lines, LINE_STRIDE, [
      { name: 'pos', size: 2, type: F, offset: 0 },
      { name: 'self', size: 3, type: F, offset: 8 },
      { name: 'other', size: 3, type: F, offset: 20 },
    ])
    this.bands = new Layer(gl, bands, BAND_STRIDE, [
      { name: 'corner', size: 2, type: F, offset: 0 },
      { name: 'ends', size: 4, type: F, offset: 8 },
      { name: 'aEnd', size: 3, type: F, offset: 24 },
      { name: 'bEnd', size: 3, type: F, offset: 36 },
      { name: 'style', size: 2, type: F, offset: 48 },
    ])
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  private uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>()

  private uniform(program: WebGLProgram, name: string): WebGLUniformLocation | null {
    let known = this.uniforms.get(program)
    if (!known) this.uniforms.set(program, (known = new Map()))
    if (!known.has(name)) known.set(name, this.gl.getUniformLocation(program, name))
    return known.get(name)!
  }

  /** The largest point the device draws: dots bigger than that would be cut. */
  maxPoint(): number {
    const range = this.gl.getParameter(this.gl.ALIASED_POINT_SIZE_RANGE) as Float32Array
    return range?.[1] ?? 64
  }

  render(camera: Camera, width: number, height: number, dpr: number, colors: Colors, focusOn: boolean) {
    const gl = this.gl
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    const draw = (layer: Layer, mode: number) => {
      if (!layer.count) return
      gl.useProgram(layer.program)
      const u = (name: string) => this.uniform(layer.program, name)
      gl.uniform3f(u('cam'), camera.x, camera.y, camera.k)
      gl.uniform2f(u('size'), width, height)
      gl.uniform1f(u('dpr'), dpr)
      gl.uniform1f(u('focusOn'), focusOn ? 1 : 0)
      gl.uniform1f(u('light'), colors.light ? 1 : 0)
      gl.uniform3f(u('edge'), ...colors.edge)
      gl.uniform3f(u('accent'), ...colors.accent)
      gl.bindVertexArray(layer.vao)
      gl.drawArrays(mode, 0, layer.count)
    }
    draw(this.bubbles, gl.TRIANGLES)
    draw(this.lines, gl.LINES)
    draw(this.bands, gl.TRIANGLES)
    draw(this.points, gl.POINTS)
    gl.bindVertexArray(null)
  }

  destroy() {
    for (const layer of [this.points, this.bubbles, this.lines, this.bands]) layer.destroy()
    for (const program of this.programs) this.gl.deleteProgram(program)
  }
}
