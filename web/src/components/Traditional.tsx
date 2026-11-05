import { useEffect, useRef, useState } from 'react'
import { FlipHorizontal2, FlipVertical2, Link2, Link2Off, RotateCcw, RotateCw, Ruler, Wand } from 'lucide-react'
import { api, fileUrl } from '../api'
import { assetOf, ensureAsset, useStore, type Tool } from '../store'
import { autoTone, describe, developer, isNeutral, NEUTRAL, pickAdjustments, type Adjustments, type Histogram } from '../develop'
import { covered, fitCrop } from '../reframe'
import { straighten } from './actions'
import { ImageSlot, Slider, Toggle } from './ui'

function Title({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="panel-title">
      <div>
        <h2>{title}</h2>
        <p>{sub}</p>
      </div>
    </div>
  )
}

/** Saves a rotated or flipped copy straight away and keeps cropping that one. */
async function transformNow(body: { rotate?: number; flip?: 'h' | 'v' }) {
  const s = useStore.getState()
  const id = s.expand.image
  if (!id) return
  try {
    const a = await api.transform(id, body)
    s.upsertAsset(a)
    s.useImage('crop', a.id)
  } catch (e: any) {
    s.toast(e.message, 'error')
  }
}

const CROP_RATIOS: [string, number][] = [
  ['1:1', 1],
  ['4:5', 4 / 5],
  ['5:4', 5 / 4],
  ['3:2', 3 / 2],
  ['2:3', 2 / 3],
  ['16:9', 16 / 9],
  ['9:16', 9 / 16],
]

export function CropPanel() {
  const f = useStore((s) => s.expand)
  const patch = useStore((s) => s.patch)
  const p = (v: Partial<typeof f>) => patch('expand', v)
  const a = assetOf(f.image)
  const refit = () => setTimeout(() => window.dispatchEvent(new Event('mozaic:fit')), 0)
  const toAspect = (ratio: number | null) => {
    if (!a) return
    refit()
    p({ ratio, ...fitCrop(a.width, a.height, f.angle, ratio ?? a.width / a.height) })
  }
  const W = a ? a.width + f.left + f.right : 0
  const H = a ? a.height + f.top + f.bottom : 0
  return (
    <>
      <Title title="Crop" sub="Crop, straighten, rotate and flip" />
      <ImageSlot big id={f.image} label="Image to crop" onSet={(id) => useStore.getState().useImage('crop', id)} />
      <div className="field">
        <label>
          Aspect {a && <span className="val">{W} × {H}</span>}
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
          <button className={`btn sm ${a && f.ratio !== null && Math.abs(f.ratio - a.width / a.height) < 0.001 ? 'on' : ''}`} disabled={!a} onClick={() => a && toAspect(a.width / a.height)} title="Keep the photo's own shape">
            Original
          </button>
          {CROP_RATIOS.map(([l, r]) => (
            <button key={l} className={`btn sm ${f.ratio !== null && Math.abs(f.ratio - r) < 0.001 ? 'on' : ''}`} disabled={!a} onClick={() => toAspect(r)}>
              {l}
            </button>
          ))}
        </div>
        <span className="hint">Or drag the edges on the canvas for a free crop.</span>
      </div>
      <Slider label="Straighten" value={f.angle} min={-45} max={45} step={0.1} onChange={(v) => straighten(v, true)} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}°`} />
      <div className="row" style={{ gap: 4 }}>
        <button className={`btn sm ${f.leveling ? 'on' : ''}`} disabled={!a} onClick={() => p({ leveling: !f.leveling })} title="Drag along a line in the photo that should be level or upright">
          <Ruler size={14} /> Draw a level line
        </button>
        <button className="btn sm ghost" disabled={!a || !f.angle} onClick={() => straighten(0, true)}>
          0°
        </button>
      </div>
      <div className="field">
        <label>
          Rotate and flip <span className="hint">saves a copy right away</span>
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
          <button className="btn sm" disabled={!a} title="Rotate 90° left" onClick={() => transformNow({ rotate: -90 })}>
            <RotateCcw size={14} />
          </button>
          <button className="btn sm" disabled={!a} title="Rotate 90° right" onClick={() => transformNow({ rotate: 90 })}>
            <RotateCw size={14} />
          </button>
          <button className="btn sm" disabled={!a} title="Flip vertically" onClick={() => transformNow({ flip: 'v' })}>
            <FlipHorizontal2 size={14} />
          </button>
          <button className="btn sm" disabled={!a} title="Flip horizontally" onClick={() => transformNow({ flip: 'h' })}>
            <FlipVertical2 size={14} />
          </button>
        </div>
      </div>
      <button className="btn sm ghost" disabled={!a || !(f.left || f.right || f.top || f.bottom || f.angle)} onClick={() => (refit(), p({ left: 0, top: 0, right: 0, bottom: 0, angle: 0, ratio: null }))}>
        Reset crop
      </button>
      <div className="tip">Crops are instant and keep the full resolution. To add canvas around a photo instead, use Expand in Qwen Image.</div>
    </>
  )
}

/** A centred slider for one adjustment: double-click it to put it back to neutral. */
function Adj({ k, label, min = -100, max = 100, step = 1, format }: { k: keyof Adjustments; label: string; min?: number; max?: number; step?: number; format?: (v: number) => string }) {
  const v = useStore((s) => s.adjust[k]) as number
  const patch = useStore((s) => s.patch)
  const zero = NEUTRAL[k] as number
  const pct = ((v - min) / (max - min)) * 100
  const mid = ((zero - min) / (max - min)) * 100
  return (
    <div className="field adj" onDoubleClick={() => patch('adjust', { [k]: zero })} title="Double-click to reset">
      <span className="label">
        {label} <span className={`val ${v !== zero ? 'changed' : ''}`}>{format ? format(v) : `${v > 0 ? '+' : ''}${v}`}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        style={{ ['--from' as string]: `${Math.min(pct, mid)}%`, ['--to' as string]: `${Math.max(pct, mid)}%` }}
        onChange={(e) => patch('adjust', { [k]: Number(e.target.value) })}
      />
    </div>
  )
}

function Group({ title, keys, children }: { title: string; keys: (keyof Adjustments)[]; children: React.ReactNode }) {
  const changed = useStore((s) => keys.some((k) => s.adjust[k] !== NEUTRAL[k]))
  const patch = useStore((s) => s.patch)
  return (
    <div className="adj-group">
      <div className="adj-head">
        <b>{title}</b>
        {changed && (
          <button className="btn sm ghost" onClick={() => patch('adjust', Object.fromEntries(keys.map((k) => [k, NEUTRAL[k]])))}>
            Reset
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

function HistogramView({ h }: { h: Histogram | null }) {
  if (!h) return <div className="histogram" />
  const peak = Math.max(1, ...h.r, ...h.g, ...h.b, ...h.l)
  const path = (bins: number[]) => `M0,64 ${bins.map((v, i) => `L${i + 0.5},${64 - Math.min(64, (Math.sqrt(v / peak) * 64))}`).join(' ')} L64,64 Z`
  return (
    <svg className="histogram" viewBox="0 0 64 64" preserveAspectRatio="none">
      <path d={path(h.l)} className="l" />
      <path d={path(h.r)} className="r" />
      <path d={path(h.g)} className="g" />
      <path d={path(h.b)} className="b" />
    </svg>
  )
}

export function AdjustPanel() {
  const f = useStore((s) => s.adjust)
  const patch = useStore((s) => s.patch)
  const hist = useStore((s) => s.histogram)
  const toast = useStore((s) => s.toast)
  const auto = () => {
    if (!f.image || developer.src !== fileUrl(f.image)) return
    const h = developer.histogram({ ...NEUTRAL, exposure: f.exposure }, false)
    if (h) patch('adjust', autoTone(h))
    else toast('The photo is still loading', 'info')
  }
  const ev = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV`
  return (
    <>
      <Title title="Adjust" sub="Light, colour and finishing touches" />
      <ImageSlot big id={f.image} label="Image to adjust" onSet={(id) => useStore.getState().useImage('adjust', id)} />
      <HistogramView h={hist} />
      <div className="row" style={{ gap: 4 }}>
        <button className="btn sm" disabled={!f.image} onClick={auto} title="Set whites, blacks, shadows and highlights from the photo">
          <Wand size={14} /> Auto
        </button>
        <button className={`btn sm ${f.original ? 'on' : ''}`} disabled={!f.image} onClick={() => patch('adjust', { original: !f.original })} title="Show the photo without adjustments (\)">
          Original
        </button>
        <button className="btn sm ghost" style={{ marginLeft: 'auto' }} disabled={isNeutral(pickAdjustments(f))} onClick={() => patch('adjust', { ...NEUTRAL, original: false })}>
          Reset all
        </button>
      </div>
      <Group title="Light" keys={['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks']}>
        <Adj k="exposure" label="Exposure" min={-4} max={4} step={0.05} format={ev} />
        <Adj k="contrast" label="Contrast" />
        <Adj k="highlights" label="Highlights" />
        <Adj k="shadows" label="Shadows" />
        <Adj k="whites" label="Whites" />
        <Adj k="blacks" label="Blacks" />
      </Group>
      <Group title="Colour" keys={['temperature', 'tint', 'vibrance', 'saturation', 'hue', 'bw']}>
        <Adj k="temperature" label="Temperature" />
        <Adj k="tint" label="Tint" />
        <Adj k="vibrance" label="Vibrance" />
        <Adj k="saturation" label="Saturation" />
        <Adj k="hue" label="Hue" min={-180} max={180} format={(v) => `${v > 0 ? '+' : ''}${v}°`} />
        <Toggle on={f.bw} onChange={(v) => patch('adjust', { bw: v })} label="Black & white" />
      </Group>
      <Group title="Detail" keys={['clarity', 'sharpen']}>
        <Adj k="clarity" label="Clarity" />
        <Adj k="sharpen" label="Sharpen" min={0} format={(v) => String(v)} />
      </Group>
      <Group title="Effects" keys={['vignette', 'vignetteSize', 'grain']}>
        <Adj k="vignette" label="Vignette" />
        <Adj k="vignetteSize" label="Vignette size" min={0} format={(v) => String(v)} />
        <Adj k="grain" label="Grain" min={0} format={(v) => String(v)} />
      </Group>
      <span className="hint">Sharpen and grain are true to size at 100% zoom. Double-click a slider to reset it.</span>
    </>
  )
}

/** The live Adjust preview: the shader's canvas, standing in for the photo in the viewer. */
export function AdjustCanvas({ id, w, h }: { id: string; w: number; h: number }) {
  const host = useRef<HTMLDivElement>(null)
  const f = useStore((s) => s.adjust)
  const set = useStore((s) => s.set)
  const toast = useStore((s) => s.toast)
  const [ready, setReady] = useState(false)
  const histTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    let alive = true
    setReady(false)
    const src = fileUrl(id)
    developer
      .load(src)
      .then(() => {
        if (!alive || developer.src !== src) return
        const c = developer.canvas
        c.className = 'adjust-canvas'
        c.style.width = `${w}px`
        c.style.height = `${h}px`
        host.current?.replaceChildren(c)
        setReady(true)
      })
      .catch((e) => alive && toast(e.message, 'error'))
    return () => {
      alive = false
    }
  }, [id, w, h, toast])

  useEffect(() => {
    if (!ready) return
    const a = pickAdjustments(f)
    const frame = requestAnimationFrame(() => developer.render(a, f.original))
    clearTimeout(histTimer.current)
    histTimer.current = setTimeout(() => set({ histogram: developer.histogram(a, f.original) }), 120)
    return () => cancelAnimationFrame(frame)
  }, [ready, f, set])

  return <div ref={host} style={{ position: 'absolute', inset: 0 }} />
}

const LONG_EDGES = [1080, 1600, 2048, 3840]

export function ResizePanel() {
  const f = useStore((s) => s.resize)
  const patch = useStore((s) => s.patch)
  const a = assetOf(f.image)
  const w = f.width || a?.width || 0
  const h = f.height || a?.height || 0
  const setW = (v: number) => patch('resize', f.lock && a ? { width: v, height: Math.max(1, Math.round((v * a.height) / a.width)) } : { width: v })
  const setH = (v: number) => patch('resize', f.lock && a ? { height: v, width: Math.max(1, Math.round((v * a.width) / a.height)) } : { height: v })
  const scale = (k: number) => a && patch('resize', { width: Math.round(a.width * k), height: Math.round(a.height * k) })
  const edge = (e: number) => a && (a.width >= a.height ? setW(e) : setH(e))
  return (
    <>
      <Title title="Resize" sub="Scale to an exact size" />
      <ImageSlot big id={f.image} label="Image to resize" onSet={(id) => useStore.getState().useImage('resize', id)} />
      {a && <span className="hint">Now {a.width} × {a.height}</span>}
      <div className="field">
        <label>Scale</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
          {[0.25, 0.5, 0.75, 2].map((k) => (
            <button key={k} className="btn sm" disabled={!a} onClick={() => scale(k)}>
              {k * 100}%
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Long edge</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
          {LONG_EDGES.map((e) => (
            <button key={e} className="btn sm" disabled={!a} onClick={() => edge(e)}>
              {e}
            </button>
          ))}
        </div>
      </div>
      <div className="row" style={{ gap: 6, alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Width</label>
          <input type="number" min={8} max={16384} value={w || ''} disabled={!a} onChange={(e) => setW(Number(e.target.value))} />
        </div>
        <button className={`btn icon ${f.lock ? 'on' : ''}`} style={{ flex: '0 0 32px', marginBottom: 1 }} title={f.lock ? 'Keeping the aspect ratio' : 'Width and height are independent'} onClick={() => patch('resize', { lock: !f.lock })}>
          {f.lock ? <Link2 size={14} /> : <Link2Off size={14} />}
        </button>
        <div className="field" style={{ flex: 1 }}>
          <label>Height</label>
          <input type="number" min={8} max={16384} value={h || ''} disabled={!a} onChange={(e) => setH(Number(e.target.value))} />
        </div>
      </div>
      {a && w * h > a.width * a.height * 1.05 && <div className="tip">Making a photo bigger this way only interpolates. For real added detail, upscale with Remix in Qwen Image.</div>}
    </>
  )
}

export function canRunTraditional(tool: Tool): string | null {
  const s = useStore.getState()
  if (tool === 'crop') {
    const f = s.expand
    const a = assetOf(f.image)
    if (!a) return 'Choose an image'
    if (!(f.left || f.right || f.top || f.bottom || f.angle)) return 'Drag the edges or straighten'
    return covered(a.width, a.height, f, f.angle) ? null : 'Keep the crop inside the photo'
  }
  if (tool === 'adjust') return !s.adjust.image ? 'Choose an image' : isNeutral(pickAdjustments(s.adjust)) ? 'Move a slider' : null
  const a = assetOf(s.resize.image)
  if (!a) return 'Choose an image'
  const w = s.resize.width || a.width
  const h = s.resize.height || a.height
  if (w < 8 || h < 8 || w > 16384 || h > 16384) return 'Sizes go from 8 to 16384'
  return w === a.width && h === a.height ? 'Pick a new size' : null
}

export const TRADITIONAL_LABEL: Partial<Record<Tool, string>> = { crop: 'Crop', adjust: 'Save adjusted copy', resize: 'Resize' }

export async function runTraditional(tool: Tool) {
  const s = useStore.getState()
  if (canRunTraditional(tool)) return
  if (tool === 'crop') {
    const f = s.expand
    return s.run('expand', { image: f.image, left: f.left, top: f.top, right: f.right, bottom: f.bottom, angle: f.angle, prompt: '', fill: 'blur', protect: true })
  }
  if (tool === 'adjust') {
    const f = s.adjust
    const settings = pickAdjustments(f)
    try {
      if (developer.src !== fileUrl(f.image!)) await developer.load(fileUrl(f.image!))
      const blob = await developer.export(settings)
      const a = await api.saveRendered(f.image!, blob, settings, describe(settings))
      s.upsertAsset(a)
      useStore.getState().useImage('adjust', a.id)
      s.patch('adjust', { ...NEUTRAL, original: false })
      s.toast('Saved an adjusted copy', 'success')
      return a
    } catch (e: any) {
      s.toast(e.message, 'error')
      return
    }
  }
  const f = s.resize
  const a = assetOf(f.image)!
  try {
    const out = await api.transform(a.id, { width: f.width || a.width, height: f.height || a.height })
    s.upsertAsset(out)
    s.useImage('resize', out.id)
    return out
  } catch (e: any) {
    s.toast(e.message, 'error')
  }
}

/** Opens an adjusted image's source in Adjust with the settings it was made with, to keep tweaking them. */
export async function reuseAdjustments(params: Record<string, any>, parent: string) {
  const s = useStore.getState()
  await ensureAsset(parent)
  s.useImage('adjust', parent)
  s.patch('adjust', { ...pickAdjustments(params), original: false })
  s.toast('Loaded these adjustments onto the original', 'success')
}
