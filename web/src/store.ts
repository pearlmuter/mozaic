import { create } from 'zustand'
import { api, type Asset, type EngineStatus, type Job, type Models, type Op, type Settings, type SetupStatus } from './api'

export type Tool = 'create' | 'edit' | 'region' | 'expand' | 'cutout' | 'remix' | 'layout'
export type ModelId = 'qwen' | 'moss'

export const MODEL_TOOLS: Record<ModelId, Tool[]> = {
  qwen: ['create', 'edit', 'region', 'expand', 'cutout', 'remix'],
  moss: ['create', 'layout'],
}
export const MODEL_NAMES: Record<ModelId, string> = { qwen: 'Qwen Image 2.1', moss: 'MOSS-Image' }
export type View = 'studio' | 'library'

export type Sampling = {
  steps: number
  cfg: number
  sampler: string
  scheduler: string
  seed: number
  lockSeed: boolean
  count: number
  negative: string
  loras: { name: string; strength: number }[]
}

export type CreateForm = { prompt: string; aspect: string; megapixels: number; transparent: boolean; customW: number; customH: number }
export type EditForm = { prompt: string; images: string[]; resolution: string; transparent: boolean }
export type RegionForm = {
  image: string | null
  prompt: string
  method: 'outline' | 'mask' | 'repaint'
  references: string[]
  protect: boolean
  grow: number
  feather: number
  strength: number
}
// Sides above 0 grow the canvas, below 0 crop it. `angle` straightens (degrees, clockwise); with `fit` on, the
// frame shrinks to the largest crop of `ratio` (null: the photo's own) that the turned photo still fills.
export type ExpandForm = {
  image: string | null
  left: number
  top: number
  right: number
  bottom: number
  angle: number
  fit: boolean
  ratio: number | null
  leveling: boolean
  prompt: string
  fill: string
  protect: boolean
}
export type CutoutForm = { image: string | null; subject: string }
export type RemixForm = { image: string | null; prompt: string; strength: number; scale: number; useReference: boolean }

export type MossForm = {
  prompt: string
  negative: string
  aspect: string
  megapixels: number
  customW: number
  customH: number
  checkpoint: 'sft' | 'base'
  turbo: boolean
  steps: number
  cfg: number
  shift: number
  seed: number
  lockSeed: boolean
  count: number
  loras: { name: string; strength: number }[]
}

// Layout boxes are stored in fractions of the canvas (0..1, top-left origin) so they survive size changes.
export type LayoutItem = { id: string; label: 'text' | 'object'; caption: string; text: string; box: [number, number, number, number] }
export type LayoutForm = { summary: string; items: LayoutItem[]; selected: string | null }

export type MaskTool = 'brush' | 'eraser' | 'rect' | 'ellipse' | 'lasso'

export type Toast = { id: number; text: string; kind: 'info' | 'error' | 'success' }

type State = {
  view: View
  tool: Tool
  engine: EngineStatus | null
  setup: SetupStatus | null
  activeModel: ModelId
  engines: Partial<Record<ModelId, EngineStatus>>
  setups: Partial<Record<ModelId, SetupStatus>>
  mossInfo: { loras: string[] } | null
  layoutView: 'edit' | 'result'
  moss: MossForm
  layout: LayoutForm
  connected: boolean
  jobs: Job[]
  assets: Asset[]
  assetMap: Record<string, Asset>
  viewing: string | null
  live: string | null // job id the viewer is following
  previews: Record<string, string>
  compare: boolean
  models: Models | null
  settings: Settings | null
  settingsOpen: boolean
  pickerFor: null | { title: string; onPick: (id: string) => void }
  toasts: Toast[]
  sampling: Sampling
  create: CreateForm
  edit: EditForm
  region: RegionForm
  expand: ExpandForm
  cutout: CutoutForm
  remix: RemixForm
  mask: { tool: MaskTool; size: number; version: number; hasMask: boolean }

  set: (p: Partial<State>) => void
  patch: <K extends 'create' | 'edit' | 'region' | 'expand' | 'cutout' | 'remix' | 'sampling' | 'mask' | 'moss' | 'layout'>(k: K, v: Partial<State[K]>) => void
  toast: (text: string, kind?: Toast['kind']) => void
  upsertAsset: (a: Asset) => void
  removeAsset: (id: string) => void
  upsertJob: (j: Job) => void
  show: (id: string | null) => void
  useImage: (tool: Tool, id: string) => void
  newImage: () => void
  loadAssets: () => Promise<void>
  loadSettings: () => Promise<void>
  loadModels: () => Promise<void>
  applyEngines: (active: ModelId, engines: Partial<Record<ModelId, EngineStatus>>, setups?: Partial<Record<ModelId, SetupStatus>>) => void
  switchModel: (m: ModelId) => Promise<void>
  run: (op: Op, params: Record<string, any>) => Promise<Job | null>
}

const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem('mozaic.ui') || '{}')
  } catch {
    return {}
  }
})()

let toastId = 0

export const useStore = create<State>((set, get) => ({
  view: 'studio',
  tool: saved.tool ?? 'create',
  engine: null,
  setup: null,
  activeModel: 'qwen',
  engines: {},
  setups: {},
  mossInfo: null,
  layoutView: 'edit',
  moss: {
    prompt: '', negative: '', aspect: '1:1', megapixels: 1, customW: 1024, customH: 1024, checkpoint: 'sft', turbo: true,
    steps: 50, cfg: 3, shift: 5, seed: -1, lockSeed: false, count: 1, loras: [],
    ...(saved.moss ?? {}),
  },
  layout: {
    summary: '',
    selected: null,
    items: [],
    ...(saved.layout ?? {}),
  },
  connected: false,
  jobs: [],
  assets: [],
  assetMap: {},
  viewing: null,
  live: null,
  previews: {},
  compare: false,
  models: null,
  settings: null,
  settingsOpen: false,
  pickerFor: null,
  toasts: [],
  sampling: {
    steps: 30, cfg: 1, sampler: 'euler', scheduler: 'simple', seed: -1, lockSeed: false, count: 1, negative: '', loras: [],
    ...(saved.sampling ?? {}),
  },
  create: { prompt: '', aspect: '1:1', megapixels: 1, transparent: false, customW: 1024, customH: 1024, ...(saved.create ?? {}) },
  edit: { prompt: '', images: [], resolution: 'match', transparent: false },
  region: { image: null, prompt: '', method: 'outline', references: [], protect: true, grow: 8, feather: 12, strength: 1 },
  expand: { image: null, left: 0, top: 0, right: 0, bottom: 0, angle: 0, fit: true, ratio: null, leveling: false, prompt: '', fill: 'blur', protect: true },
  cutout: { image: null, subject: '' },
  remix: { image: null, prompt: '', strength: 0.45, scale: 1, useReference: false },
  mask: { tool: 'brush', size: 60, version: 0, hasMask: false },

  set: (p) => set(p),
  patch: (k, v) => set((s) => ({ [k]: { ...(s[k] as object), ...v } }) as Partial<State>),
  toast: (text, kind = 'info') => {
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 7000 : 3500)
  },
  upsertAsset: (a) =>
    set((s) => {
      const exists = !!s.assetMap[a.id]
      const assetMap = { ...s.assetMap, [a.id]: a }
      if (a.hidden) return { assetMap }
      const assets = exists ? s.assets.map((x) => (x.id === a.id ? a : x)) : [a, ...s.assets]
      return { assetMap, assets }
    }),
  removeAsset: (id) =>
    set((s) => {
      const assetMap = { ...s.assetMap }
      delete assetMap[id]
      const assets = s.assets.filter((a) => a.id !== id)
      const viewing = s.viewing === id ? (assets[0]?.id ?? null) : s.viewing
      return { assetMap, assets, viewing }
    }),
  upsertJob: (j) =>
    set((s) => {
      const exists = s.jobs.some((x) => x.id === j.id)
      const jobs = exists ? s.jobs.map((x) => (x.id === j.id ? j : x)) : [j, ...s.jobs]
      const out: Partial<State> = { jobs: jobs.slice(0, 200) }
      if (j.status === 'running' && s.live === j.id && s.tool === 'layout') out.layoutView = 'result'
      if (j.status === 'done' && s.live === j.id && j.outputs.length) {
        out.viewing = j.outputs[0]
        out.live = null
        out.layoutView = 'result'
      }
      if ((j.status === 'error' || j.status === 'cancelled') && s.live === j.id) out.live = null
      if (j.status !== 'running' && s.previews[j.id]) {
        const previews = { ...s.previews }
        delete previews[j.id]
        out.previews = previews
      }
      return out
    }),
  show: (id) => set({ viewing: id, live: null, compare: false, layoutView: 'result' }),
  useImage: (tool, id) => {
    const s = get()
    if (tool === 'edit') s.patch('edit', { images: [id, ...s.edit.images.filter((x) => x !== id)].slice(0, 10) })
    else if (tool === 'region') s.patch('region', { image: id })
    else if (tool === 'expand') s.patch('expand', { image: id, left: 0, top: 0, right: 0, bottom: 0, angle: 0, ratio: null, leveling: false })
    else if (tool === 'cutout') s.patch('cutout', { image: id })
    else if (tool === 'remix') s.patch('remix', { image: id })
    set({ tool, view: 'studio', viewing: id, live: null, compare: false })
  },
  // A blank stage for the next prompt; the previous image stays in the library and the prompt is kept to tweak.
  newImage: () => {
    const s = get()
    set({ tool: s.tool === 'layout' ? 'layout' : 'create', view: 'studio', viewing: null, live: null, compare: false, layoutView: 'edit' })
    requestAnimationFrame(() => window.dispatchEvent(new Event('mozaic:focus-prompt')))
  },
  loadAssets: async () => {
    const res = await api.assets({ limit: 400 })
    const assetMap: Record<string, Asset> = { ...get().assetMap }
    res.items.forEach((a) => (assetMap[a.id] = a))
    set({ assets: res.items, assetMap, viewing: get().viewing ?? (get().assets.length ? null : (res.items[0]?.id ?? null)) })
  },
  loadSettings: async () => set({ settings: await api.settings() }),
  loadModels: async () => {
    try {
      if (get().activeModel === 'moss') set({ mossInfo: await api.mossInfo() })
      else set({ models: await api.models() })
    } catch {
      /* engine not ready yet */
    }
  },
  applyEngines: (active, engines, setups) => {
    const s = get()
    const allEngines = { ...s.engines, ...engines }
    const allSetups = { ...s.setups, ...(setups ?? {}) }
    const out: Partial<State> = { activeModel: active, engines: allEngines, setups: allSetups, engine: allEngines[active] ?? null, setup: allSetups[active] ?? null }
    if (!MODEL_TOOLS[active].includes(s.tool)) out.tool = 'create'
    set(out)
  },
  switchModel: async (m) => {
    const s = get()
    if (s.activeModel === m) return
    s.applyEngines(m, {})
    try {
      const r = await api.setModel(m)
      get().applyEngines(r.active_model, r.engines)
      get().loadModels()
    } catch (e: any) {
      s.toast(e.message, 'error')
    }
  },
  run: async (op, params) => {
    const s = get()
    if (params.model === 'moss') {
      try {
        const job = await api.submit(op, params)
        s.upsertJob(job)
        set({ live: job.id, compare: false })
        if (!s.moss.lockSeed && s.moss.seed !== -1) s.patch('moss', { seed: -1 })
        return job
      } catch (e: any) {
        s.toast(e.message, 'error')
        return null
      }
    }
    const smp = s.sampling
    const full = {
      steps: smp.steps, cfg: smp.cfg, sampler: smp.sampler, scheduler: smp.scheduler,
      seed: smp.seed, count: smp.count, negative_prompt: smp.negative, loras: smp.loras,
      ...params,
    }
    try {
      const job = await api.submit(op, full)
      s.upsertJob(job)
      // Plain crops come back already done: open the result in Expand, ready to crop or straighten again.
      if (job.status === 'done' && job.outputs[0]) {
        await ensureAsset(job.outputs[0])
        get().useImage(s.tool, job.outputs[0])
        return job
      }
      if (job.status === 'error') throw new Error(job.error ?? 'Failed')
      set({ live: job.id, compare: false })
      if (!smp.lockSeed && smp.seed !== -1) s.patch('sampling', { seed: -1 })
      return job
    } catch (e: any) {
      s.toast(e.message, 'error')
      return null
    }
  },
}))

// Persist a few UI preferences between launches.
useStore.subscribe((s) => {
  try {
    localStorage.setItem('mozaic.ui', JSON.stringify({ tool: s.tool, sampling: s.sampling, create: s.create, moss: s.moss, layout: { ...s.layout, selected: null } }))
  } catch {
    /* storage unavailable */
  }
})

export function assetOf(id: string | null | undefined): Asset | undefined {
  return id ? useStore.getState().assetMap[id] : undefined
}

export async function ensureAsset(id: string) {
  const s = useStore.getState()
  if (s.assetMap[id]) return s.assetMap[id]
  const a = await api.asset(id)
  s.upsertAsset(a)
  return a
}
