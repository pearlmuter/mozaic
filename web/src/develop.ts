// Traditional › Adjust: classic photo adjustments in one WebGL shader. The same render is the live preview and,
// read back at full resolution, the saved image, so what you see is exactly what gets saved.

export type Adjustments = {
  exposure: number // EV, -4..4
  contrast: number // the rest go from -100 to 100 unless noted
  highlights: number
  shadows: number
  whites: number
  blacks: number
  temperature: number
  tint: number
  vibrance: number
  saturation: number
  hue: number // degrees, -180..180
  clarity: number
  sharpen: number // 0..100
  vignette: number
  vignetteSize: number // 0..100
  grain: number // 0..100
  bw: boolean
}

export const NEUTRAL: Adjustments = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  temperature: 0, tint: 0, vibrance: 0, saturation: 0, hue: 0,
  clarity: 0, sharpen: 0, vignette: 0, vignetteSize: 50, grain: 0, bw: false,
}

export const ADJUSTMENT_KEYS = Object.keys(NEUTRAL) as (keyof Adjustments)[]

export function pickAdjustments(a: Partial<Adjustments>): Adjustments {
  const out = { ...NEUTRAL }
  for (const k of ADJUSTMENT_KEYS) if (a[k] !== undefined) (out as any)[k] = a[k]
  return out
}

export function isNeutral(a: Adjustments) {
  return ADJUSTMENT_KEYS.every((k) => k === 'vignetteSize' ? !a.vignette || a.vignetteSize === NEUTRAL.vignetteSize : a[k] === NEUTRAL[k])
}

const LABELS: Partial<Record<keyof Adjustments, string>> = {
  exposure: 'Exposure', contrast: 'Contrast', highlights: 'Highlights', shadows: 'Shadows', whites: 'Whites',
  blacks: 'Blacks', temperature: 'Temperature', tint: 'Tint', vibrance: 'Vibrance', saturation: 'Saturation',
  hue: 'Hue', clarity: 'Clarity', sharpen: 'Sharpen', vignette: 'Vignette', grain: 'Grain',
}

/** A short caption for the saved image, e.g. "Exposure +0.5, Contrast +20, Black & white". */
export function describe(a: Adjustments) {
  const parts = (Object.keys(LABELS) as (keyof Adjustments)[])
    .filter((k) => a[k] !== NEUTRAL[k])
    .map((k) => `${LABELS[k]} ${(a[k] as number) > 0 ? '+' : ''}${k === 'exposure' ? (a[k] as number).toFixed(2) : a[k]}`)
  if (a.bw) parts.push('Black & white')
  return parts.length ? parts.join(', ') : 'Adjust'
}

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`

// Light and white balance work on linear light; the tonal and colour controls on gamma-encoded values,
// which is where they look even. Every control is exactly neutral at 0, so an untouched photo comes out unchanged.
const FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_size, u_out;
uniform float u_lod, u_exposure, u_contrast, u_highlights, u_shadows, u_whites, u_blacks;
uniform float u_temp, u_tint, u_vibrance, u_saturation, u_hue, u_clarity, u_sharpen;
uniform float u_vignette, u_vigSize, u_grain;
uniform bool u_bw, u_original;
out vec4 o;

vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float scurve(float x, float g) { return x < 0.5 ? 0.5 * pow(2.0 * x, g) : 1.0 - 0.5 * pow(2.0 - 2.0 * x, g); }

void main() {
  vec2 uv = vec2(gl_FragCoord.x / u_out.x, 1.0 - gl_FragCoord.y / u_out.y);
  vec4 src = texture(u_tex, uv);
  if (u_original) { o = src; return; }
  vec3 c = src.rgb;
  if (u_sharpen > 0.0) {
    vec2 px = 1.0 / u_size;
    vec3 around = textureLod(u_tex, uv + vec2(px.x, 0.0), 0.0).rgb + textureLod(u_tex, uv - vec2(px.x, 0.0), 0.0).rgb
                + textureLod(u_tex, uv + vec2(0.0, px.y), 0.0).rgb + textureLod(u_tex, uv - vec2(0.0, px.y), 0.0).rgb;
    c = clamp(c + u_sharpen * (c - around * 0.25), 0.0, 1.0);
  }

  vec3 lin = toLinear(c);
  vec3 wb = vec3(1.0 + u_temp * 0.3, 1.0 - u_tint * 0.25, 1.0 - u_temp * 0.3);
  lin *= wb / luma(wb) * exp2(u_exposure);
  vec3 v = toSrgb(lin);

  float L0 = luma(v);
  float bp = -u_blacks * 0.25;
  float wp = 1.0 - u_whites * 0.25;
  float L = (L0 - bp) / max(wp - bp, 0.05);
  float x = clamp(L, 0.0, 1.0);
  L += u_shadows * x * (1.0 - x) * (1.0 - x) + u_highlights * x * x * (1.0 - x);
  if (u_clarity != 0.0) {
    vec2 r = vec2(exp2(u_lod)) / u_size;
    vec3 blur = (textureLod(u_tex, uv, u_lod).rgb + textureLod(u_tex, uv + vec2(r.x, r.y), u_lod).rgb
               + textureLod(u_tex, uv + vec2(-r.x, r.y), u_lod).rgb + textureLod(u_tex, uv + vec2(r.x, -r.y), u_lod).rgb
               + textureLod(u_tex, uv - r, u_lod).rgb) / 5.0;
    x = clamp(L, 0.0, 1.0);
    L += u_clarity * 0.9 * (luma(src.rgb) - luma(blur)) * 4.0 * x * (1.0 - x);
  }
  x = clamp(L, 0.0, 1.0);
  L = scurve(x, exp(u_contrast * 0.9)) + (L - x);
  // Carry the new brightness over in proportion, except in the deepest shadows where that would amplify noise.
  v = mix(v + (L - L0), v * (L / max(L0, 1e-4)), smoothstep(0.0, 0.08, L0));

  float l = luma(v);
  float sat = max(max(v.r, v.g), v.b) - min(min(v.r, v.g), v.b);
  v = mix(vec3(l), v, 1.0 + u_saturation + u_vibrance * (1.0 - clamp(sat, 0.0, 1.0)));
  if (u_hue != 0.0) {
    float y = dot(v, vec3(0.299, 0.587, 0.114));
    float i = dot(v, vec3(0.596, -0.274, -0.322));
    float q = dot(v, vec3(0.211, -0.523, 0.312));
    float cs = cos(u_hue), sn = sin(u_hue);
    vec2 iq = vec2(i * cs - q * sn, i * sn + q * cs);
    v = vec3(y + 0.956 * iq.x + 0.621 * iq.y, y - 0.272 * iq.x - 0.647 * iq.y, y - 1.106 * iq.x + 1.703 * iq.y);
  }
  if (u_bw) v = vec3(luma(v));

  if (u_vignette != 0.0) {
    float aspect = u_size.x / u_size.y;
    float rr = length((uv - 0.5) * vec2(aspect, 1.0)) / length(vec2(aspect * 0.5, 0.5));
    float w = smoothstep(mix(0.95, 0.05, u_vigSize), 1.15, rr);
    v = u_vignette < 0.0 ? v * (1.0 + u_vignette * w) : mix(v, vec3(1.0), u_vignette * w);
  }
  if (u_grain > 0.0) {
    vec2 p = floor(uv * u_size);
    float n = (hash(p) + hash(p + 17.31) - 1.0);
    l = clamp(luma(v), 0.0, 1.0);
    v += n * u_grain * 0.14 * (0.35 + 2.6 * l * (1.0 - l));
  }
  o = vec4(clamp(v, 0.0, 1.0), src.a);
}`

export type Histogram = { r: number[]; g: number[]; b: number[]; l: number[] }

class Developer {
  readonly canvas = document.createElement('canvas')
  private gl: WebGL2RenderingContext | null = null
  private tex: WebGLTexture | null = null
  private fbo: { fb: WebGLFramebuffer; w: number; h: number } | null = null
  private uni: Record<string, WebGLUniformLocation | null> = {}
  private loading: Promise<void> | null = null
  src: string | null = null
  width = 0
  height = 0

  private init() {
    if (this.gl) return this.gl
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false })
    if (!gl) throw new Error('This Mac’s browser view has no WebGL 2, which Adjust needs')
    const shader = (type: number, code: string) => {
      const sh = gl.createShader(type)!
      gl.shaderSource(sh, code)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader error')
      return sh
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link error')
    gl.useProgram(prog)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'p')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    for (const n of ['u_tex', 'u_size', 'u_out', 'u_lod', 'u_exposure', 'u_contrast', 'u_highlights', 'u_shadows', 'u_whites', 'u_blacks', 'u_temp', 'u_tint', 'u_vibrance', 'u_saturation', 'u_hue', 'u_clarity', 'u_sharpen', 'u_vignette', 'u_vigSize', 'u_grain', 'u_bw', 'u_original'])
      this.uni[n] = gl.getUniformLocation(prog, n)
    this.gl = gl
    return gl
  }

  /** Loads an image into the shader; resolves once it can be rendered. */
  load(src: string): Promise<void> {
    if (this.src === src && this.loading) return this.loading
    this.src = src
    this.loading = (async () => {
      const img = new Image()
      img.src = src
      await img.decode()
      if (this.src !== src) return
      const gl = this.init()
      const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
      if (img.naturalWidth > max || img.naturalHeight > max) throw new Error(`Adjust works on images up to ${max} pixels a side`)
      if (this.tex) gl.deleteTexture(this.tex)
      this.tex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, this.tex)
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img)
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      this.width = img.naturalWidth
      this.height = img.naturalHeight
      this.canvas.width = this.width
      this.canvas.height = this.height
    })()
    this.loading.catch(() => {
      if (this.src === src) this.src = null
    })
    return this.loading
  }

  private draw(a: Adjustments, original: boolean, w: number, h: number) {
    const gl = this.gl!
    const u = this.uni
    gl.viewport(0, 0, w, h)
    gl.uniform1i(u.u_tex, 0)
    gl.uniform2f(u.u_size, this.width, this.height)
    gl.uniform2f(u.u_out, w, h)
    // Clarity compares each pixel with its surroundings about 1.5% of the image across.
    gl.uniform1f(u.u_lod, Math.max(1, Math.log2(Math.max(this.width, this.height) * 0.015)))
    gl.uniform1f(u.u_exposure, a.exposure)
    gl.uniform1f(u.u_contrast, a.contrast / 100)
    gl.uniform1f(u.u_highlights, a.highlights / 100)
    gl.uniform1f(u.u_shadows, a.shadows / 100)
    gl.uniform1f(u.u_whites, a.whites / 100)
    gl.uniform1f(u.u_blacks, a.blacks / 100)
    gl.uniform1f(u.u_temp, a.temperature / 100)
    gl.uniform1f(u.u_tint, a.tint / 100)
    gl.uniform1f(u.u_vibrance, a.vibrance / 100)
    gl.uniform1f(u.u_saturation, a.saturation / 100)
    gl.uniform1f(u.u_hue, (a.hue * Math.PI) / 180)
    gl.uniform1f(u.u_clarity, a.clarity / 100)
    gl.uniform1f(u.u_sharpen, (a.sharpen / 100) * 1.5)
    gl.uniform1f(u.u_vignette, a.vignette / 100)
    gl.uniform1f(u.u_vigSize, a.vignetteSize / 100)
    gl.uniform1f(u.u_grain, a.grain / 100)
    gl.uniform1i(u.u_bw, a.bw ? 1 : 0)
    gl.uniform1i(u.u_original, original ? 1 : 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /** Renders the loaded image at full size into `canvas`. */
  render(a: Adjustments, original = false) {
    if (!this.gl || !this.tex) return
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null)
    this.draw(a, original, this.width, this.height)
  }

  /** RGB and luminance histograms (64 bins each) of a small render with the same settings. */
  histogram(a: Adjustments, original = false): Histogram | null {
    const gl = this.gl
    if (!gl || !this.tex) return null
    const w = Math.min(256, this.width)
    const h = Math.max(1, Math.round((w * this.height) / this.width))
    if (!this.fbo || this.fbo.w !== w || this.fbo.h !== h) {
      const t = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      const fb = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0)
      gl.bindTexture(gl.TEXTURE_2D, this.tex)
      this.fbo = { fb, w, h }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.fb)
    this.draw(a, original, w, h)
    const px = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const out: Histogram = { r: Array(64).fill(0), g: Array(64).fill(0), b: Array(64).fill(0), l: Array(64).fill(0) }
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 8) continue
      out.r[px[i] >> 2]++
      out.g[px[i + 1] >> 2]++
      out.b[px[i + 2] >> 2]++
      out.l[Math.min(63, (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) >> 2)]++
    }
    return out
  }

  /** The current render as a PNG, at the image's full resolution. */
  async export(a: Adjustments): Promise<Blob> {
    this.render(a)
    return new Promise((resolve, reject) => this.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image'))), 'image/png'))
  }
}

export const developer = new Developer()

/** Auto tone: stretch the darkest and brightest half percent of the photo to black and white. */
export function autoTone(h: Histogram): Partial<Adjustments> {
  const total = h.l.reduce((s, v) => s + v, 0) || 1
  const at = (frac: number) => {
    let acc = 0
    for (let i = 0; i < 64; i++) if ((acc += h.l[i]) >= total * frac) return (i + 0.5) / 64
    return 1
  }
  const lo = at(0.005)
  const hi = at(0.995)
  const mid = at(0.5)
  const clamp = (v: number) => Math.round(Math.max(-100, Math.min(100, v)))
  return {
    whites: clamp(((1 - hi) / 0.25) * 100),
    blacks: clamp((-lo / 0.25) * 100),
    // Lift a dark photo's shadows a little, or hold back a bright one's highlights.
    shadows: clamp(mid < 0.35 ? (0.35 - mid) * 150 : 0),
    highlights: clamp(mid > 0.65 ? (0.65 - mid) * 150 : 0),
  }
}
