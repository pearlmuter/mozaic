import { Brush, Expand, LayoutTemplate, Scissors, Shuffle, Sparkles, Wand2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { api, type Asset } from '../api'
import { assetOf, useStore, type Tool } from '../store'
import { fitCrop } from '../reframe'
import { fromMossLayout } from './MossPanels'

export const TOOL_NAMES: Record<Tool, string> = {
  create: 'Create',
  edit: 'Edit',
  region: 'Region',
  expand: 'Expand',
  cutout: 'Cut out',
  remix: 'Remix',
  layout: 'Layout',
}

export const TOOL_ICONS: Record<Tool, (size: number) => ReactNode> = {
  create: (s) => <Sparkles size={s} />,
  edit: (s) => <Wand2 size={s} />,
  region: (s) => <Brush size={s} />,
  expand: (s) => <Expand size={s} />,
  cutout: (s) => <Scissors size={s} />,
  remix: (s) => <Shuffle size={s} />,
  layout: (s) => <LayoutTemplate size={s} />,
}

export const OP_TOOL: Record<string, Tool> = { generate: 'create', edit: 'edit', region: 'region', expand: 'expand', cutout: 'cutout', remix: 'remix' }

/** Loads an image's recorded parameters back into the matching tool. */
export function reuseSettings(a: Asset) {
  const s = useStore.getState()
  const p = a.params || {}
  if (p.model === 'moss') {
    s.patch('moss', {
      prompt: p.layout ? s.moss.prompt : (p.prompt ?? ''),
      negative: p.negative_prompt ?? '',
      checkpoint: p.checkpoint ?? 'sft',
      turbo: !!p.turbo,
      steps: p.steps ?? 50,
      cfg: p.cfg ?? 3,
      shift: p.shift ?? 5,
      seed: p.seed ?? -1,
      lockSeed: p.seed !== undefined,
      count: 1,
      loras: p.loras ?? [],
      aspect: 'custom',
      customW: p.width ?? a.width,
      customH: p.height ?? a.height,
    })
    if (p.layout) s.patch('layout', { ...fromMossLayout(p.layout, p.width ?? a.width, p.height ?? a.height), selected: null })
    if (s.activeModel !== 'moss') s.switchModel('moss')
    s.set({ tool: p.layout ? 'layout' : 'create', view: 'studio' })
    s.toast(`Loaded settings into MOSS ${p.layout ? 'Layout' : 'Create'} (seed ${p.seed} locked)`, 'success')
    return
  }
  const tool = OP_TOOL[a.op]
  if (!tool) return
  if (s.activeModel !== 'qwen') s.switchModel('qwen')
  s.patch('sampling', {
    steps: p.steps ?? s.sampling.steps,
    cfg: p.cfg ?? s.sampling.cfg,
    sampler: p.sampler ?? s.sampling.sampler,
    scheduler: p.scheduler ?? s.sampling.scheduler,
    seed: p.seed ?? -1,
    lockSeed: p.seed !== undefined,
    negative: p.negative_prompt ?? '',
    loras: p.loras ?? [],
    count: 1,
  })
  if (tool === 'create') {
    const known = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'].includes(p.aspect)
    s.patch('create', {
      prompt: p.prompt ?? '',
      transparent: !!p.transparent,
      aspect: known && p.megapixels ? p.aspect : 'custom',
      megapixels: p.megapixels ?? s.create.megapixels,
      customW: p.width ?? a.width,
      customH: p.height ?? a.height,
    })
  } else if (tool === 'edit') {
    s.patch('edit', { prompt: p.prompt ?? '', images: p.images ?? a.parents, transparent: !!p.transparent, resolution: p.resolution ? String(p.resolution) : 'match' })
  } else if (tool === 'region') {
    s.patch('region', { image: p.image, prompt: p.prompt ?? '', method: p.method ?? 'outline', references: p.references ?? [], protect: p.protect ?? true, grow: p.grow ?? 8, feather: p.feather ?? 12, strength: p.strength ?? 1 })
  } else if (tool === 'expand') {
    s.patch('expand', { image: p.image, left: p.left ?? 0, top: p.top ?? 0, right: p.right ?? 0, bottom: p.bottom ?? 0, angle: p.angle ?? 0, ratio: null, leveling: false, prompt: p.prompt ?? '', fill: p.fill ?? 'blur', protect: p.protect ?? true })
  } else if (tool === 'cutout') {
    s.patch('cutout', { image: p.image, subject: p.subject ?? '' })
  } else if (tool === 'remix') {
    s.patch('remix', { image: p.image, prompt: p.prompt ?? '', strength: p.strength ?? 0.45, scale: p.scale ?? 1, useReference: p.use_reference ?? false })
  }
  s.set({ tool, view: 'studio' })
  if (tool !== 'create' && tool !== 'edit') {
    const target = p.image
    if (target) s.set({ viewing: target, live: null, compare: false })
  }
  s.toast(`Loaded settings into ${TOOL_NAMES[tool]}${p.seed !== undefined ? ` (seed ${p.seed} locked)` : ''}`, 'success')
}

/** Imports dropped or pasted files and shows the first one. */
export async function importFiles(files: File[]) {
  const s = useStore.getState()
  const images = files.filter((f) => f.type.startsWith('image/'))
  if (!images.length) return
  try {
    const added = await api.upload(images)
    added.forEach((a) => s.upsertAsset(a))
    const first = added[0]
    if (first) {
      if (s.tool === 'create') s.useImage('edit', first.id)
      else s.useImage(s.tool, first.id)
    }
    s.toast(`Imported ${added.length} image${added.length > 1 ? 's' : ''}`, 'success')
  } catch (e: any) {
    s.toast(e.message, 'error')
  }
}

/** Sets the Expand straighten angle; with "Crop to fit" on, the frame shrinks to what the turned photo fills. */
export function straighten(angle: number, fit?: boolean) {
  const s = useStore.getState()
  const f = s.expand
  const a = assetOf(f.image)
  if (!a) return
  angle = Math.round(Math.max(-45, Math.min(45, angle)) * 10) / 10
  fit = fit ?? f.fit
  s.patch('expand', fit ? { angle, fit, ...fitCrop(a.width, a.height, angle, f.ratio ?? a.width / a.height) } : { angle, fit })
}
