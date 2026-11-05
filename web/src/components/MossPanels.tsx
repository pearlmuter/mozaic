import { Dice5, Lock, Plus, Trash2, Type, Box, Unlock } from 'lucide-react'
import { useStore, type LayoutItem, type MossForm, type Tool } from '../store'
import { Details, PromptBox, Seg, Toggle } from './ui'

const ASPECTS = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', 'custom']
const SIZES = [
  { v: 0.5, label: '0.5 MP' },
  { v: 1, label: '1 MP' },
  { v: 1.5, label: '1.5 MP' },
  { v: 2.02, label: '2 MP · max' },
]

const snap16 = (v: number) => Math.max(16, Math.round(v / 16) * 16)

/** Same sizing as the server: aspect at a pixel budget (1 MP = 1024²), multiples of 16. */
export function mossSize(f: Pick<MossForm, 'aspect' | 'megapixels' | 'customW' | 'customH'>): [number, number] {
  if (f.aspect === 'custom') return [snap16(f.customW), snap16(f.customH)]
  const [a, b] = f.aspect.split(':').map(Number)
  const area = f.megapixels * 1024 * 1024
  return [snap16(Math.sqrt((area * a) / b)), snap16(Math.sqrt((area * b) / a))]
}

/** Layout boxes (fractions, top-left origin) to MOSS's JSON: [y_min, x_min, y_max, x_max] in pixels from the centre. */
export function toMossLayout(summary: string, items: LayoutItem[], w: number, h: number) {
  return {
    summary: { caption: summary.trim() },
    items: items.map((it) => {
      const [x0, y0, x1, y1] = it.box
      const caption = it.caption.trim() || (it.label === 'text' ? `Text reading "${it.text}"` : 'An object')
      return {
        label: it.label,
        caption,
        ...(it.label === 'text' && it.text.trim() ? { text: it.text } : {}),
        bbox: [Math.round(y0 * h - h / 2), Math.round(x0 * w - w / 2), Math.round(y1 * h - h / 2), Math.round(x1 * w - w / 2)],
      }
    }),
    bbox_format: 'yxyx',
    bbox_coord_space: 'abs_centralized',
  }
}

export function fromMossLayout(layout: any, w: number, h: number): { summary: string; items: LayoutItem[] } {
  const items: LayoutItem[] = (layout?.items ?? []).map((it: any, i: number) => {
    const [y0, x0, y1, x1] = it.bbox ?? [-h / 4, -w / 4, h / 4, w / 4]
    return {
      id: `i${Date.now()}${i}`,
      label: it.label === 'text' ? 'text' : 'object',
      caption: it.caption ?? '',
      text: it.text ?? '',
      box: [(x0 + w / 2) / w, (y0 + h / 2) / h, (x1 + w / 2) / w, (y1 + h / 2) / h],
    }
  })
  return { summary: layout?.summary?.caption ?? '', items }
}

function Title({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="panel-title">
      <div>
        <h2>
          {title} <span className="model-tag">MOSS</span>
        </h2>
        <p>{sub}</p>
      </div>
    </div>
  )
}

function SizeFields() {
  const f = useStore((s) => s.moss)
  const patch = useStore((s) => s.patch)
  const p = (v: Partial<MossForm>) => patch('moss', v)
  const [w, h] = mossSize(f)
  return (
    <>
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
            <input type="number" step={16} min={256} max={2048} value={f.customW} onChange={(e) => p({ customW: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label>Height</label>
            <input type="number" step={16} min={256} max={2048} value={f.customH} onChange={(e) => p({ customH: Number(e.target.value) })} />
          </div>
        </div>
      ) : (
        <div className="field">
          <label>Size</label>
          <Seg value={f.megapixels} onChange={(v) => p({ megapixels: v })} options={SIZES} />
          <span className="hint">MOSS is trained around 1 MP; it accepts up to 1456×1456.</span>
        </div>
      )}
    </>
  )
}

/** Negative prompt, checkpoint, Turbo, count and the advanced sampler settings. */
function MossSettings() {
  const f = useStore((s) => s.moss)
  const info = useStore((s) => s.mossInfo)
  const patch = useStore((s) => s.patch)
  const p = (v: Partial<MossForm>) => patch('moss', v)
  return (
    <>
      <div className="field">
        <label>Negative prompt</label>
        <textarea style={{ minHeight: 60 }} value={f.negative} onChange={(e) => p({ negative: e.target.value })} placeholder="What to keep out of the image" />
        <span className="hint">MOSS uses real guidance (CFG {f.cfg}), so this has a strong effect.</span>
      </div>
      <div className="field">
        <label>Checkpoint</label>
        <Seg
          value={f.checkpoint}
          onChange={(v) => p({ checkpoint: v, turbo: v === 'base' ? false : f.turbo })}
          options={[
            { v: 'sft', label: 'SFT', title: 'Fine-tuned on curated data: cleaner composition and text' },
            { v: 'base', label: 'Base', title: 'The pretrained model before fine-tuning: rawer and less curated' },
          ]}
        />
        <span className="hint">{f.checkpoint === 'sft' ? 'Polished: cleaner composition and text.' : 'Rawer and less curated than SFT. Standard sampling only.'}</span>
      </div>
      <Toggle
        on={f.turbo && f.checkpoint === 'sft'}
        onChange={(v) => p({ turbo: v, checkpoint: v ? 'sft' : f.checkpoint })}
        label="Turbo"
        hint={f.turbo ? 'About 6× faster (15 passes). Weaker on small dense text.' : 'Full 50-step sampling: best quality, about 6× slower.'}
      />
      <div className="field">
        <label>Images</label>
        <Seg value={f.count} onChange={(v) => p({ count: v })} options={[1, 2, 4, 8].map((v) => ({ v, label: String(v) }))} />
      </div>
      <Details title="Advanced">
        <div className="grid2">
          <div className="field">
            <label>Steps {f.turbo && <span className="hint">Turbo: fixed</span>}</label>
            <input type="number" min={1} max={200} value={f.steps} disabled={f.turbo} onChange={(e) => p({ steps: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label>CFG</label>
            <input type="number" min={1} max={12} step={0.1} value={f.cfg} onChange={(e) => p({ cfg: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label>Shift</label>
            <input type="number" min={0.5} max={12} step={0.5} value={f.shift} disabled={f.turbo} onChange={(e) => p({ shift: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label>Seed</label>
            <div className="row" style={{ gap: 4 }}>
              <input type="number" value={f.seed === -1 ? '' : f.seed} placeholder="Random" onChange={(e) => p({ seed: e.target.value === '' ? -1 : Number(e.target.value) })} />
              <button className="btn icon" style={{ flex: '0 0 32px' }} title="Random seed" onClick={() => p({ seed: -1 })}>
                <Dice5 size={15} />
              </button>
              <button className={`btn icon ${f.lockSeed ? 'on' : ''}`} style={{ flex: '0 0 32px' }} title={f.lockSeed ? 'Seed is kept between runs' : 'Seed resets to random after each run'} onClick={() => p({ lockSeed: !f.lockSeed })}>
                {f.lockSeed ? <Lock size={14} /> : <Unlock size={14} />}
              </button>
            </div>
          </div>
        </div>
        <div className="row" style={{ gap: 4 }}>
          <button className="btn sm" onClick={() => p({ steps: 50, cfg: 3, shift: 5 })}>
            Official defaults · 50 / CFG 3 / shift 5
          </button>
        </div>
        <div className="field">
          <label>
            LoRAs
            <button className="btn sm ghost" disabled={!info?.loras.length} title={info?.loras.length ? 'Add a LoRA' : 'No LoRAs found'} onClick={() => p({ loras: [...f.loras, { name: info!.loras[0], strength: 1 }] })}>
              <Plus size={13} /> Add
            </button>
          </label>
          {!info?.loras.length && <span className="hint">Put kohya-format MOSS DiT LoRAs (.safetensors) in ~/Library/Application Support/Mozaic/models/loras.</span>}
          {f.loras.map((l, i) => (
            <div key={i} className="lora-row">
              <select value={l.name} onChange={(e) => p({ loras: f.loras.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}>
                {info?.loras.map((x) => <option key={x}>{x}</option>)}
              </select>
              <input type="number" step={0.05} value={l.strength} onChange={(e) => p({ loras: f.loras.map((x, j) => (j === i ? { ...x, strength: Number(e.target.value) } : x)) })} />
              <button className="btn sm icon ghost" onClick={() => p({ loras: f.loras.filter((_, j) => j !== i) })}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </Details>
      <div className="tip">
        <b>Timing on this Mac:</b> about {f.turbo ? '2–3 minutes' : '12–15 minutes'} per 1 MP image, plus up to a minute to load the model the first time.
      </div>
    </>
  )
}

export function MossCreatePanel() {
  const f = useStore((s) => s.moss)
  const patch = useStore((s) => s.patch)
  return (
    <>
      <Title title="Create" sub="Text to image with strong text rendering" />
      <div className="field">
        <label>Prompt</label>
        <PromptBox value={f.prompt} onChange={(v) => patch('moss', { prompt: v })} placeholder={'Describe the image. Words to render go in "quotes". Long, detailed prompts work well (up to 4K tokens).'} />
      </div>
      <SizeFields />
      <MossSettings />
    </>
  )
}

export function newLayoutItem(label: 'text' | 'object', box?: LayoutItem['box']): LayoutItem {
  return { id: `i${Date.now()}${Math.random().toString(36).slice(2, 6)}`, label, caption: '', text: label === 'text' ? 'Your text' : '', box: box ?? [0.3, 0.4, 0.7, 0.6] }
}

export function LayoutPanel() {
  const l = useStore((s) => s.layout)
  const patch = useStore((s) => s.patch)
  const p = (v: Partial<typeof l>) => patch('layout', v)
  const update = (id: string, v: Partial<LayoutItem>) => p({ items: l.items.map((it) => (it.id === id ? { ...it, ...v } : it)) })
  const add = (label: 'text' | 'object') => {
    const it = newLayoutItem(label)
    p({ items: [...l.items, it], selected: it.id })
  }
  return (
    <>
      <Title title="Layout" sub="Place text and objects; MOSS composes the image around them" />
      <div className="field">
        <label>Whole image</label>
        <textarea style={{ minHeight: 80 }} value={l.summary} onChange={(e) => p({ summary: e.target.value })} placeholder="Describe the overall scene, mood and style, e.g. a minimalist travel poster with a cream background" />
      </div>
      <SizeFields />
      <div className="field">
        <label>
          Elements <span className="hint">{l.items.length}</span>
        </label>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm" onClick={() => add('text')}>
            <Type size={13} /> Add text
          </button>
          <button className="btn sm" onClick={() => add('object')}>
            <Box size={13} /> Add object
          </button>
        </div>
        <span className="hint">Or drag on the canvas to draw a box. Drag boxes to move them, the corner to resize.</span>
        {l.items.map((it, i) => (
          <div key={it.id} className={`layout-item ${l.selected === it.id ? 'sel' : ''}`} onClick={() => p({ selected: it.id })}>
            <div className="row" style={{ gap: 6 }}>
              <span className="layout-num">{i + 1}</span>
              <Seg
                value={it.label}
                onChange={(v) => update(it.id, { label: v, text: v === 'text' && !it.text ? 'Your text' : it.text })}
                options={[
                  { v: 'text', label: 'Text' },
                  { v: 'object', label: 'Object' },
                ]}
              />
              <button className="btn sm icon ghost" style={{ flex: '0 0 26px' }} title="Remove" onClick={(e) => (e.stopPropagation(), p({ items: l.items.filter((x) => x.id !== it.id), selected: null }))}>
                <Trash2 size={13} />
              </button>
            </div>
            {it.label === 'text' && <input value={it.text} onChange={(e) => update(it.id, { text: e.target.value })} placeholder="Exact words to render" />}
            <input value={it.caption} onChange={(e) => update(it.id, { caption: e.target.value })} placeholder={it.label === 'text' ? 'How it looks, e.g. large bold red serif title' : 'What it is, e.g. a vintage bicycle'} />
          </div>
        ))}
      </div>
      <MossSettings />
    </>
  )
}

function common(f: MossForm) {
  return {
    model: 'moss',
    negative_prompt: f.negative,
    checkpoint: f.checkpoint,
    turbo: f.turbo && f.checkpoint === 'sft',
    steps: f.steps,
    cfg: f.cfg,
    shift: f.shift,
    seed: f.seed,
    count: f.count,
    loras: f.loras,
  }
}

export function runMoss(tool: Tool) {
  const s = useStore.getState()
  const f = s.moss
  const [w, h] = mossSize(f)
  if (tool === 'layout') {
    const l = s.layout
    return s.run('generate', { ...common(f), width: w, height: h, layout: toMossLayout(l.summary, l.items, w, h) })
  }
  return s.run('generate', { ...common(f), prompt: f.prompt, width: w, height: h })
}

export function canRunMoss(tool: Tool): string | null {
  const s = useStore.getState()
  if (tool === 'layout') return !s.layout.summary.trim() ? 'Describe the whole image' : null
  return s.moss.prompt.trim() ? null : 'Write a prompt'
}
