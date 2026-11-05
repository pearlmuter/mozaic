export type Asset = {
  id: string
  path: string
  name: string
  width: number
  height: number
  has_alpha: boolean
  source: string
  op: string
  prompt: string
  params: Record<string, any>
  parents: string[]
  job_id: string | null
  favorite: boolean
  hidden: boolean
  created_at: number
}

export type Job = {
  id: string
  op: Op
  params: Record<string, any>
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  progress: number
  phase: string
  error: string | null
  outputs: string[]
  text: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
  step: number
  steps: number
  index: number
  count: number
}

export type Op = 'generate' | 'edit' | 'region' | 'expand' | 'cutout' | 'remix'

export type EngineStatus = {
  model?: string
  state: 'stopped' | 'setup' | 'starting' | 'ready' | 'error'
  detail: string
  mode: string
  url: string
  managed_pid: number | null
}

export type SetupFile = { label: string; name: string; size: number; done: number; state: string; source: string }

export type SetupStatus = {
  model: string
  title: string
  engine_label: string
  engine_size: number
  state: 'idle' | 'running' | 'ready' | 'error'
  step: string
  detail: string
  error: string | null
  engine_ready: boolean
  engine_progress: number
  models_ready: boolean
  files: SetupFile[]
  downloaded: number
  to_download: number
  speed: number
  disk_free: number
  disk_needed: number
  ram_gb: number
  warnings: string[]
}

export type Status = {
  version: string
  engine: EngineStatus
  pending_jobs: number
  library_count: number
  library_dir: string
  mcp_url: string
  mcp_command: string[]
}

export type Models = {
  unet: string[]
  text_encoder: string[]
  vae: string[]
  loras: string[]
  samplers: string[]
  schedulers: string[]
  weight_dtypes: string[]
  selected: Record<string, string>
}

export type Settings = {
  comfy_mode: string
  comfy_path: string
  comfy_url: string
  comfy_port: number
  models_dirs: string[]
  auto_start_engine: boolean
  unet: string
  weight_dtype: string
  text_encoder: string
  vae: string
  cache_device: string
  cache_dtype: string
  steps: number
  cfg: number
  sampler: string
  scheduler: string
  megapixels: number
  library_dir: string
  active_model: string
  moss_checkpoint: string
  moss_keep_resident: boolean
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method }
  if (body instanceof FormData) init.body = body
  else if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'content-type': 'application/json' }
  }
  const r = await fetch(path, init)
  if (!r.ok) {
    let msg = r.statusText
    try {
      const j = await r.json()
      msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j)
    } catch {
      /* not json */
    }
    throw new Error(msg)
  }
  return r.json()
}

export const api = {
  status: () => req<Status>('GET', '/api/status'),
  setupStart: () => req<SetupStatus>('POST', '/api/setup/start'),
  setupCancel: () => req<SetupStatus>('POST', '/api/setup/cancel'),
  setModel: (model: string) => req<{ active_model: 'qwen' | 'moss'; engines: Record<string, EngineStatus> }>('POST', '/api/model', { model }),
  mossInfo: () => req<{ loras: string[] }>('GET', '/api/moss'),
  engine: (action: 'start' | 'stop' | 'restart' | 'free') => req<EngineStatus>('POST', `/api/engine/${action}`),
  models: () => req<Models>('GET', '/api/models'),
  settings: () => req<Settings>('GET', '/api/settings'),
  saveSettings: (s: Partial<Settings>) => req<Settings>('PUT', '/api/settings', s),
  assets: (params: { limit?: number; offset?: number; q?: string; favorites?: boolean; op?: string } = {}) => {
    const sp = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => v !== undefined && v !== '' && v !== false && sp.set(k, String(v)))
    return req<{ items: Asset[]; total: number }>('GET', `/api/assets?${sp}`)
  },
  asset: (id: string) => req<Asset>('GET', `/api/assets/${id}`),
  upload: (files: File[] | Blob[], hidden = false) => {
    const fd = new FormData()
    files.forEach((f, i) => fd.append('files', f, (f as File).name || `image-${i}.png`))
    fd.append('hidden', String(hidden))
    return req<Asset[]>('POST', '/api/assets/upload', fd)
  },
  importSource: (source: string) => req<Asset>('POST', '/api/assets/import', { source }),
  patch: (id: string, body: Partial<Pick<Asset, 'favorite' | 'name'>>) => req<Asset>('PATCH', `/api/assets/${id}`, body),
  trash: (id: string) => req<{ ok: boolean }>('DELETE', `/api/assets/${id}`),
  reveal: (id: string) => req<{ ok: boolean }>('POST', `/api/assets/${id}/reveal`),
  submit: (op: Op, params: Record<string, any>) => req<Job>('POST', '/api/jobs', { op, params }),
  jobs: () => req<Job[]>('GET', '/api/jobs'),
  job: (id: string) => req<Job>('GET', `/api/jobs/${id}`),
  wait: (id: string, timeout = 60) => req<Job>('GET', `/api/jobs/${id}/wait?timeout=${timeout}`),
  cancel: (id: string) => req<{ ok: boolean }>('POST', `/api/jobs/${id}/cancel`),
}

export const fileUrl = (id: string) => `/api/assets/${id}/file`
export const thumbUrl = (id: string) => `/api/assets/${id}/thumb`

// Native shell bridge (WKWebView). Falls back to browser behaviour when absent.
type Bridge = { postMessage: (m: unknown) => void }
const bridge = (): Bridge | undefined => (window as any).webkit?.messageHandlers?.mozaic

export const native = {
  available: () => !!bridge(),
  saveAs: (a: Asset) => {
    const b = bridge()
    if (b) b.postMessage({ action: 'saveAs', path: a.path, name: suggestedName(a) })
    else {
      const link = document.createElement('a')
      link.href = `${fileUrl(a.id)}?download=1`
      link.download = suggestedName(a)
      link.click()
    }
  },
  copyImage: async (a: Asset) => {
    const b = bridge()
    if (b) return b.postMessage({ action: 'copyImage', path: a.path })
    const blob = await (await fetch(fileUrl(a.id))).blob()
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  },
  openUrl: (url: string) => {
    const b = bridge()
    if (b) b.postMessage({ action: 'openUrl', url })
    else window.open(url, '_blank')
  },
}

function suggestedName(a: Asset) {
  const base = (a.prompt || a.name || a.op).replace(/[^\w\s-]/g, '').trim().slice(0, 48).replace(/\s+/g, '-')
  return `${base || 'mozaic'}-${a.id}.png`
}
