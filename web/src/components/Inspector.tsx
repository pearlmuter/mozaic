import { Dice5, Lock, Plus, Ruler, Trash2, Unlock } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useStore, assetOf, type Tool } from '../store'
import { Details, ImageSlot, PromptBox, Seg, Slider, Toggle } from './ui'
import { exportMask } from './maskState'
import { api } from '../api'
import { covered, fitCrop } from '../reframe'
import { straighten } from './actions'
import { canRunMoss, LayoutPanel, MossCreatePanel, runMoss } from './MossPanels'
import { AdjustPanel, canRunTraditional, CropPanel, ResizePanel, runTraditional, TRADITIONAL_LABEL } from './Traditional'

const ASPECTS = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', 'custom']
const MP = [
  { v: 0.5, label: '0.5 MP' },
  { v: 1, label: '1 MP' },
  { v: 2, label: '2 MP' },
  { v: 4, label: '4 MP · 2K' },
]

function sizeFor(aspect: string, mp: number) {
  const [a, b] = aspect.split(':').map(Number)
  const area = mp * 1024 * 1024
  const snap = (v: number) => Math.max(32, Math.round(v / 32) * 32)
  return [snap(Math.sqrt((area * a) / b)), snap(Math.sqrt((area * b) / a))]
}

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

export function Advanced({ showStrength }: { showStrength?: ReactNode }) {
  const smp = useStore((s) => s.sampling)
  const models = useStore((s) => s.models)
  const patch = useStore((s) => s.patch)
  const p = (v: Partial<typeof smp>) => patch('sampling', v)
  return (
    <Details title="Advanced">
      {showStrength}
      <div className="grid2">
        <div className="field">
          <label>Steps</label>
          <input type="number" min={1} max={150} value={smp.steps} onChange={(e) => p({ steps: Number(e.target.value) })} />
        </div>
        <div className="field">
          <label>CFG</label>
          <input type="number" min={1} max={10} step={0.1} value={smp.cfg} onChange={(e) => p({ cfg: Number(e.target.value) })} />
        </div>
      </div>
      <div className="row" style={{ gap: 4 }}>
        {[
          { v: 20, l: 'Fast' },
          { v: 30, l: 'Balanced' },
          { v: 45, l: 'Official' },
        ].map((o) => (
          <button key={o.v} className={`btn sm ${smp.steps === o.v ? 'on' : ''}`} onClick={() => p({ steps: o.v })}>
            {o.l} · {o.v}
          </button>
        ))}
      </div>
      <div className="grid2">
        <div className="field">
          <label>Sampler</label>
          <select value={smp.sampler} onChange={(e) => p({ sampler: e.target.value })}>
            {(models?.samplers ?? [smp.sampler]).map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Scheduler</label>
          <select value={smp.scheduler} onChange={(e) => p({ scheduler: e.target.value })}>
            {(models?.schedulers ?? [smp.scheduler]).map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Seed</label>
        <div className="row" style={{ gap: 4 }}>
          <input
            type="number"
            value={smp.seed === -1 ? '' : smp.seed}
            placeholder="Random"
            onChange={(e) => p({ seed: e.target.value === '' ? -1 : Number(e.target.value) })}
          />
          <button className="btn icon" style={{ flex: '0 0 32px' }} title="Random seed" onClick={() => p({ seed: -1 })}>
            <Dice5 size={15} />
          </button>
          <button className={`btn icon ${smp.lockSeed ? 'on' : ''}`} style={{ flex: '0 0 32px' }} title={smp.lockSeed ? 'Seed is kept between runs' : 'Seed resets to random after each run'} onClick={() => p({ lockSeed: !smp.lockSeed })}>
            {smp.lockSeed ? <Lock size={14} /> : <Unlock size={14} />}
          </button>
        </div>
      </div>
      <div className="field">
        <label>
          Negative prompt <span className="hint">{smp.cfg <= 1 ? 'only used when CFG > 1' : ''}</span>
        </label>
        <textarea style={{ minHeight: 56 }} value={smp.negative} onChange={(e) => p({ negative: e.target.value })} placeholder="What to avoid" />
      </div>
      <div className="field">
        <label>
          LoRAs
          <button className="btn sm ghost" disabled={!models?.loras.length} title={models?.loras.length ? 'Add a LoRA' : 'No LoRAs in your loras folder'} onClick={() => p({ loras: [...smp.loras, { name: models!.loras[0], strength: 1 }] })}>
            <Plus size={13} /> Add
          </button>
        </label>
        {!models?.loras.length && <span className="hint">None installed. LoRAs in ComfyUI-Shared/models/loras show up here.</span>}
        {smp.loras.map((l, i) => (
          <div key={i} className="lora-row">
            <select value={l.name} onChange={(e) => p({ loras: smp.loras.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}>
              {models?.loras.map((x) => <option key={x}>{x}</option>)}
            </select>
            <input type="number" step={0.05} value={l.strength} onChange={(e) => p({ loras: smp.loras.map((x, j) => (j === i ? { ...x, strength: Number(e.target.value) } : x)) })} />
            <button className="btn sm icon ghost" onClick={() => p({ loras: smp.loras.filter((_, j) => j !== i) })}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </Details>
  )
}

function Count() {
  const count = useStore((s) => s.sampling.count)
  const patch = useStore((s) => s.patch)
  return (
    <div className="field">
      <label>Images</label>
      <Seg value={count} onChange={(v) => patch('sampling', { count: v })} options={[1, 2, 4, 8].map((v) => ({ v, label: String(v) }))} />
    </div>
  )
}

function CreatePanel() {
  const f = useStore((s) => s.create)
  const patch = useStore((s) => s.patch)
  const p = (v: Partial<typeof f>) => patch('create', v)
  const [w, h] = f.aspect === 'custom' ? [f.customW, f.customH] : sizeFor(f.aspect, f.megapixels)
  return (
    <>
      <Title title="Create" sub="Text to image, up to native 2K" />
      <div className="field">
        <label>Prompt</label>
        <PromptBox value={f.prompt} onChange={(v) => p({ prompt: v })} placeholder={'Describe the image. Put any words that should appear in it in "quotes".'} />
      </div>
      <div className="field">
        <label>
          Aspect ratio <span className="val">{w} × {h}</span>
        </label>
        <Seg wrap value={f.aspect} onChange={(v) => p({ aspect: v })} options={ASPECTS.map((a) => ({ v: a, label: a === 'custom' ? 'Custom' : a }))} />
      </div>
      {f.aspect === 'custom' ? (
        <div className="grid2">
          <div className="field">
            <label>Width</label>
            <input type="number" step={32} min={256} max={2752} value={f.customW} onChange={(e) => p({ customW: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label>Height</label>
            <input type="number" step={32} min={256} max={2752} value={f.customH} onChange={(e) => p({ customH: Number(e.target.value) })} />
          </div>
        </div>
      ) : (
        <div className="field">
          <label>Size</label>
          <Seg value={f.megapixels} onChange={(v) => p({ megapixels: v })} options={MP} />
        </div>
      )}
      <Toggle on={f.transparent} onChange={(v) => p({ transparent: v })} label="Transparent background" hint="Native RGBA output, saved as PNG with alpha" />
      <Count />
      <Advanced />
    </>
  )
}

function EditPanel() {
  const f = useStore((s) => s.edit)
  const patch = useStore((s) => s.patch)
  const p = (v: Partial<typeof f>) => patch('edit', v)
  const slots = [...f.images, null].slice(0, 10)
  const setAt = (i: number, id: string) => {
    const next = [...f.images]
    next[i] = id
    p({ images: next.filter(Boolean).slice(0, 10) })
  }
  return (
    <>
      <Title title="Edit" sub="Instruction editing with up to 10 images" />
      <div className="field">
        <label>
          Images <span className="hint">{f.images.length}/10</span>
        </label>
        <div className="slots">
          {slots.map((id, i) => (
            <ImageSlot
              key={i}
              id={id}
              tag={id ? `<image${i + 1}>` : undefined}
              target={i === 0}
              label={i === 0 ? 'Image to edit' : `Reference ${i + 1}`}
              onSet={(aid) => setAt(i, aid)}
              onClear={() => p({ images: f.images.filter((_, j) => j !== i) })}
            />
          ))}
        </div>
        <span className="hint">The first image is edited; the rest are references. Name them in the prompt.</span>
      </div>
      <div className="field">
        <label>Instruction</label>
        <PromptBox
         
          refs={f.images.map((_, i) => `<image${i + 1}>`)}
          value={f.prompt}
          onChange={(v) => p({ prompt: v })}
          placeholder={f.images.length > 1 ? 'e.g. Dress the person in <image1> in the jacket from <image2>; keep face, hair and pose.' : 'e.g. Change the season to winter with fresh snow; keep the composition.'}
        />
      </div>
      <div className="field">
        <label>Output size</label>
        <Seg
          value={f.resolution}
          onChange={(v) => p({ resolution: v })}
          options={[
            { v: 'match', label: 'Match input', title: 'Keep the first image’s size (max 2048²)' },
            { v: '1024', label: '1 MP' },
            { v: '1536', label: '2.25 MP' },
            { v: '2048', label: '4 MP' },
          ]}
        />
      </div>
      <Toggle on={f.transparent} onChange={(v) => p({ transparent: v })} label="Transparent result" hint="Ask for a PNG with a transparent background" />
      <Count />
      <Advanced />
    </>
  )
}

function RegionPanel() {
  const f = useStore((s) => s.region)
  const mask = useStore((s) => s.mask)
  const patch = useStore((s) => s.patch)
  const p = (v: Partial<typeof f>) => patch('region', v)
  const offset = f.method === 'mask' ? 3 : 2
  return (
    <>
      <Title title="Region" sub="Change only the part you paint" />
      <ImageSlot big id={f.image} label="Image to change" onSet={(id) => (p({ image: id }), useStore.getState().show(id))} />
      <div className="tip">
        <b>Paint</b> over the area to change in the canvas{mask.hasMask ? '' : ' (nothing painted yet)'}. Brush <span className="kbd">B</span>, eraser <span className="kbd">E</span>, size <span className="kbd">[</span> <span className="kbd">]</span>.
      </div>
      <div className="field">
        <label>What should be there</label>
        <PromptBox refs={f.references.map((_, i) => `<image${i + offset}>`)} value={f.prompt} onChange={(v) => p({ prompt: v })} placeholder="e.g. a vase of white tulips" />
      </div>
      <div className="field">
        <label>Method</label>
        <Seg
          value={f.method}
          onChange={(v) => p({ method: v })}
          options={[
            { v: 'outline', label: 'Outline', title: 'Circle the area in red on the image, the way you would mark up a print' },
            { v: 'mask', label: 'Mask image', title: 'Give the model the mask as a separate black-and-white image' },
            { v: 'repaint', label: 'Repaint', title: 'Re-noise only the masked area (classic inpainting)' },
          ]}
        />
        <span className="hint">
          {f.method === 'outline' && 'Marks the area with a red outline the model understands, then removes it.'}
          {f.method === 'mask' && 'Passes the mask as <image2>. Good for precise shapes.'}
          {f.method === 'repaint' && 'Classic inpainting. Use strength to control how much changes.'}
        </span>
      </div>
      {f.method === 'repaint' && <Slider label="Strength" value={f.strength} min={0.1} max={1} step={0.05} onChange={(v) => p({ strength: v })} format={(v) => v.toFixed(2)} />}
      <div className="field">
        <label>References (optional)</label>
        <div className="slots">
          {[...f.references, null].slice(0, 8).map((id, i) => (
            <ImageSlot
              key={i}
              id={id}
              tag={id ? `<image${i + offset}>` : undefined}
              onSet={(aid) => p({ references: [...f.references.slice(0, i), aid, ...f.references.slice(i + 1)] })}
              onClear={() => p({ references: f.references.filter((_, j) => j !== i) })}
            />
          ))}
        </div>
      </div>
      <Toggle on={f.protect} onChange={(v) => p({ protect: v })} label="Protect the rest" hint="Keep every pixel outside the mask exactly as it was" />
      <div className="grid2">
        <Slider label="Grow" value={f.grow} min={0} max={64} step={1} onChange={(v) => p({ grow: v })} format={(v) => `${v}px`} />
        <Slider label="Feather" value={f.feather} min={0} max={64} step={1} onChange={(v) => p({ feather: v })} format={(v) => `${v}px`} />
      </div>
      <Count />
      <Advanced />
    </>
  )
}

function ExpandPanel() {
  const f = useStore((s) => s.expand)
  const patch = useStore((s) => s.patch)
  const p = (v: Partial<typeof f>) => patch('expand', v)
  const a = assetOf(f.image)
  const [mode, setMode] = useState<'crop' | 'grow'>('crop')
  const refit = () => setTimeout(() => window.dispatchEvent(new Event('mozaic:fit')), 0)
  const toAspect = (ratio: number) => {
    if (!a) return
    refit()
    if (mode === 'crop') return p({ ratio, ...fitCrop(a.width, a.height, f.angle, ratio) })
    const cur = a.width / a.height
    if (ratio > cur) {
      const extra = Math.round(a.height * ratio - a.width)
      p({ left: Math.floor(extra / 2), right: Math.ceil(extra / 2), top: 0, bottom: 0, ratio: null })
    } else {
      const extra = Math.round(a.width / ratio - a.height)
      p({ top: Math.floor(extra / 2), bottom: Math.ceil(extra / 2), left: 0, right: 0, ratio: null })
    }
  }
  const all = (pct: number) => {
    if (!a) return
    refit()
    p({ left: Math.round((a.width * pct) / 2), right: Math.round((a.width * pct) / 2), top: Math.round((a.height * pct) / 2), bottom: Math.round((a.height * pct) / 2), ratio: null })
  }
  const W = a ? a.width + f.left + f.right : 0
  const H = a ? a.height + f.top + f.bottom : 0
  const cropOnly = !!a && covered(a.width, a.height, f, f.angle)
  return (
    <>
      <Title title="Expand" sub="Crop, straighten or grow the canvas" />
      <ImageSlot big id={f.image} label="Image to expand" onSet={(id) => (p({ image: id }), useStore.getState().show(id))} />
      <div className="field">
        <label>
          Aspect {a && <span className="val">{W} × {H}</span>}
        </label>
        <Seg
          value={mode}
          onChange={setMode}
          options={[
            { v: 'crop', label: 'Crop to', title: 'Cut the image down to this shape' },
            { v: 'grow', label: 'Grow to', title: 'Add canvas to reach this shape' },
          ]}
        />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 4 }}>
          {[
            ['16:9', 16 / 9],
            ['3:2', 3 / 2],
            ['1:1', 1],
            ['4:5', 4 / 5],
            ['9:16', 9 / 16],
          ].map(([l, r]) => (
            <button key={l as string} className="btn sm" disabled={!a} onClick={() => toAspect(r as number)}>
              {l}
            </button>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
          <button className="btn sm" disabled={!a || mode === 'grow'} onClick={() => a && toAspect(a.width / a.height)} title="Keep the photo's own shape">
            Original
          </button>
          <button className="btn sm" disabled={!a} onClick={() => all(0.25)}>
            +25%
          </button>
          <button className="btn sm" disabled={!a} onClick={() => all(0.5)}>
            +50%
          </button>
          <button className="btn sm ghost" disabled={!a} onClick={() => (refit(), p({ left: 0, top: 0, right: 0, bottom: 0, angle: 0, ratio: null }))}>
            Reset
          </button>
        </div>
      </div>
      <div className="grid2">
        {(['left', 'right', 'top', 'bottom'] as const).map((k) => (
          <div className="field" key={k}>
            <label>{k}</label>
            <input type="number" step={16} value={f[k]} onChange={(e) => p({ [k]: Number(e.target.value), ratio: null })} />
          </div>
        ))}
      </div>
      <span className="hint">Drag the edges on the canvas: outward to grow, inward to crop. Negative numbers crop.</span>
      <Slider label="Straighten" value={f.angle} min={-45} max={45} step={0.1} onChange={(v) => straighten(v)} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}°`} />
      <div className="row" style={{ gap: 4 }}>
        <button className={`btn sm ${f.leveling ? 'on' : ''}`} disabled={!a} onClick={() => p({ leveling: !f.leveling })} title="Drag along a line in the photo that should be level or upright">
          <Ruler size={14} /> Draw a level line
        </button>
        <button className="btn sm ghost" disabled={!a || !f.angle} onClick={() => straighten(0)}>
          0°
        </button>
      </div>
      <Toggle on={f.fit} onChange={(v) => straighten(f.angle, v)} label="Crop to fit" hint={f.fit ? 'Straightening trims the empty corners' : 'Straightening leaves corners for the model to fill'} />
      {cropOnly ? (
        <div className="tip">The photo fills the frame, so this is a plain crop: instant, full resolution, no model.</div>
      ) : (
        <>
          <div className="field">
            <label>New area (optional)</label>
            <PromptBox value={f.prompt} onChange={(v) => p({ prompt: v })} placeholder="Leave empty to continue the scene, or describe what to add, e.g. a lighthouse on the right" />
          </div>
          <div className="field">
            <label>Start fill</label>
            <Seg value={f.fill} onChange={(v) => p({ fill: v })} options={['blur', 'white', 'gray', 'transparent'].map((v) => ({ v, label: v[0].toUpperCase() + v.slice(1) }))} />
          </div>
          <Toggle on={f.protect} onChange={(v) => p({ protect: v })} label="Keep original pixels" hint="Only the new area is generated" />
          <Count />
          <Advanced />
        </>
      )}
    </>
  )
}

function CutoutPanel() {
  const f = useStore((s) => s.cutout)
  const patch = useStore((s) => s.patch)
  const p = (v: Partial<typeof f>) => patch('cutout', v)
  return (
    <>
      <Title title="Cut out" sub="Remove the background with real transparency" />
      <ImageSlot big id={f.image} label="Image to cut out" onSet={(id) => (p({ image: id }), useStore.getState().show(id))} />
      <div className="field">
        <label>Keep only (optional)</label>
        <input value={f.subject} onChange={(e) => p({ subject: e.target.value })} placeholder="e.g. the red bicycle, the woman on the left" />
        <span className="hint">Leave empty to keep the main subject.</span>
      </div>
      <div className="tip">
        The model outputs a PNG with a true alpha channel, including soft edges like hair and glass. Use <b>Edit</b> on a transparent image to change it while keeping the transparency.
      </div>
      <Count />
      <Advanced />
    </>
  )
}

function RemixPanel() {
  const f = useStore((s) => s.remix)
  const patch = useStore((s) => s.patch)
  const p = (v: Partial<typeof f>) => patch('remix', v)
  const a = assetOf(f.image)
  return (
    <>
      <Title title="Remix" sub="Variations, restyles and upscaling" />
      <ImageSlot big id={f.image} label="Source image" onSet={(id) => (p({ image: id }), useStore.getState().show(id))} />
      <div className="field">
        <label>Prompt (optional)</label>
        <PromptBox value={f.prompt} onChange={(v) => p({ prompt: v })} placeholder="Describe the result. Leave empty for a faithful refine." />
      </div>
      <Slider
        label="Strength"
        value={f.strength}
        min={0.05}
        max={1}
        step={0.05}
        onChange={(v) => p({ strength: v })}
        format={(v) => `${v.toFixed(2)} · ${v < 0.3 ? 'refine' : v < 0.6 ? 'variation' : 'reimagine'}`}
      />
      <div className="field">
        <label>
          Scale {a && <span className="val">{Math.round(a.width * f.scale)} × {Math.round(a.height * f.scale)}</span>}
        </label>
        <Seg value={f.scale} onChange={(v) => p({ scale: v })} options={[1, 1.5, 2, 3].map((v) => ({ v, label: `${v}×` }))} />
        <span className="hint">Upscales are capped at about 2048×2048. Use strength 0.2–0.35 for a clean upscale. To restyle or change content, use Edit.</span>
      </div>
      <Toggle on={f.useReference} onChange={(v) => p({ useReference: v })} label="Stay very close to the original" hint="Also shows the model the source. Best for clean upscales" />
      <Count />
      <Advanced />
    </>
  )
}

const LABEL: Partial<Record<Tool, string>> = { create: 'Generate', edit: 'Apply edit', region: 'Change region', expand: 'Expand', cutout: 'Cut out', remix: 'Remix', layout: 'Generate layout' }

export async function runTool(tool: Tool) {
  const s = useStore.getState()
  if (s.workspace === 'traditional') return runTraditional(tool)
  if (s.activeModel === 'moss') return runMoss(tool)
  if (tool === 'create') {
    const f = s.create
    const params: Record<string, any> = { prompt: f.prompt, transparent: f.transparent }
    if (f.aspect === 'custom') Object.assign(params, { width: f.customW, height: f.customH })
    else Object.assign(params, { aspect: f.aspect, megapixels: f.megapixels })
    return s.run('generate', params)
  }
  if (tool === 'edit') {
    const f = s.edit
    return s.run('edit', { prompt: f.prompt, images: f.images, resolution: f.resolution === 'match' ? undefined : Number(f.resolution), transparent: f.transparent })
  }
  if (tool === 'region') {
    const f = s.region
    if (!f.image) return s.toast('Choose an image first', 'error')
    const blob = await exportMask()
    if (!blob) return s.toast('Paint over the area you want to change first', 'error')
    const [m] = await api.upload([blob], true)
    return s.run('region', { image: f.image, mask: m.id, prompt: f.prompt, method: f.method, references: f.references, protect: f.protect, grow: f.grow, feather: f.feather, strength: f.strength })
  }
  if (tool === 'expand') {
    const f = s.expand
    return s.run('expand', { image: f.image, left: f.left, top: f.top, right: f.right, bottom: f.bottom, angle: f.angle, prompt: f.prompt, fill: f.fill, protect: f.protect })
  }
  if (tool === 'cutout') return s.run('cutout', { image: s.cutout.image, subject: s.cutout.subject })
  const f = s.remix
  return s.run('remix', { image: f.image, prompt: f.prompt, strength: f.strength, scale: f.scale, use_reference: f.useReference })
}

function canRun(tool: Tool): string | null {
  const s = useStore.getState()
  if (s.workspace === 'traditional') return canRunTraditional(tool)
  if (s.activeModel === 'moss') return canRunMoss(tool)
  if (tool === 'create') return s.create.prompt.trim() ? null : 'Write a prompt'
  if (tool === 'edit') return !s.edit.images.length ? 'Add an image' : !s.edit.prompt.trim() ? 'Write an instruction' : null
  if (tool === 'region') return !s.region.image ? 'Choose an image' : !s.region.prompt.trim() ? 'Describe the change' : !s.mask.hasMask ? 'Paint the area to change' : null
  if (tool === 'expand') return !s.expand.image ? 'Choose an image' : !(s.expand.left || s.expand.right || s.expand.top || s.expand.bottom || s.expand.angle) ? 'Drag the edges or straighten' : null
  if (tool === 'cutout') return s.cutout.image ? null : 'Choose an image'
  return s.remix.image ? null : 'Choose an image'
}

export function Inspector() {
  const tool = useStore((s) => s.tool)
  const viewing = useStore((s) => s.viewing)
  const activeModel = useStore((s) => s.activeModel)
  const workspace = useStore((s) => s.workspace)
  const traditional = workspace === 'traditional'
  const count = useStore((s) => (s.activeModel === 'moss' ? s.moss.count : s.sampling.count))
  useStore((s) => s.adjust)
  useStore((s) => s.resize)
  useStore((s) => s.moss)
  useStore((s) => s.layout)
  // Re-render when any form changes so the run button's state stays current.
  useStore((s) => s.create)
  useStore((s) => s.edit)
  useStore((s) => s.region)
  const expand = useStore((s) => s.expand)
  useStore((s) => s.cutout)
  useStore((s) => s.remix)
  useStore((s) => s.mask.hasMask)
  const engine = useStore((s) => s.engine)
  const queueing = useStore((s) => s.jobs.some((j) => j.status === 'running' || j.status === 'queued'))
  const blocker = canRun(tool)
  const expandAsset = useStore((s) => (s.expand.image ? s.assetMap[s.expand.image] : undefined))
  const cropOnly = tool === 'expand' && workspace === 'qwen' && !!expandAsset && covered(expandAsset.width, expandAsset.height, expand, expand.angle)
  const [busy, setBusy] = useState(false)

  // Single-image tools pick up the image you are looking at when they have none yet.
  useEffect(() => {
    const s = useStore.getState()
    if (!viewing) return
    if (s.workspace === 'traditional') {
      // Crop never grows the canvas; a frame left over from Expand starts fresh.
      const e = s.expand
      if (tool === 'crop' && (!e.image || e.left > 0 || e.top > 0 || e.right > 0 || e.bottom > 0)) s.useImage('crop', e.image ?? viewing)
      if (tool === 'adjust' && !s.adjust.image) s.patch('adjust', { image: viewing })
      if (tool === 'resize' && !s.resize.image) s.patch('resize', { image: viewing })
      return
    }
    if (s.workspace !== 'qwen') return
    if (tool === 'region' && !s.region.image) s.patch('region', { image: viewing })
    if (tool === 'expand' && !s.expand.image) s.patch('expand', { image: viewing })
    if (tool === 'cutout' && !s.cutout.image) s.patch('cutout', { image: viewing })
    if (tool === 'remix' && !s.remix.image) s.patch('remix', { image: viewing })
    if (tool === 'edit' && !s.edit.images.length) s.patch('edit', { images: [viewing] })
  }, [tool, viewing])

  return (
    <aside className="inspector">
      <div className="inspector-body">
        {traditional ? (
          <>
            {tool === 'crop' && <CropPanel />}
            {tool === 'adjust' && <AdjustPanel />}
            {tool === 'resize' && <ResizePanel />}
          </>
        ) : activeModel === 'moss' ? (
          <>
            {tool === 'create' && <MossCreatePanel />}
            {tool === 'layout' && <LayoutPanel />}
          </>
        ) : (
          <>
            {tool === 'create' && <CreatePanel />}
            {tool === 'edit' && <EditPanel />}
            {tool === 'region' && <RegionPanel />}
            {tool === 'expand' && <ExpandPanel />}
            {tool === 'cutout' && <CutoutPanel />}
            {tool === 'remix' && <RemixPanel />}
          </>
        )}
      </div>
      <div className="inspector-foot">
        <button
          className="btn primary big"
          disabled={!!blocker || busy}
          onClick={async () => {
            setBusy(true)
            try {
              await runTool(tool)
            } finally {
              setBusy(false)
            }
          }}
          title={queueing && !cropOnly && !traditional ? 'Runs after the jobs ahead of it (⌘ Enter)' : '⌘ Enter'}
        >
          {busy && traditional ? 'Saving…' : blocker ?? (traditional ? (tool === 'crop' && expand.angle ? 'Straighten and crop' : TRADITIONAL_LABEL[tool]) : cropOnly ? (expand.angle ? 'Straighten' : 'Crop') : `${queueing ? 'Add to queue' : LABEL[tool]}${count > 1 ? ` · ${count}` : ''}`)}
        </button>
        {engine && engine.state !== 'ready' && !cropOnly && !traditional && <span className="hint" style={{ textAlign: 'center' }}>Jobs wait in the queue until the engine is ready.</span>}
      </div>
    </aside>
  )
}
