import { useEffect, useState } from 'react'
import { AlertTriangle, Images, Loader2, Play, Search, Settings as Gear, Star, Square, X } from 'lucide-react'
import { api, thumbUrl, type Asset, type Job } from '../api'
import { MODEL_NAMES, MODEL_TOOLS, useStore, type ModelId } from '../store'
import { MozaicMark } from './Viewer'
import { TOOL_ICONS, TOOL_NAMES } from './actions'

export function TopBar() {
  const engine = useStore((s) => s.engine)
  const setup = useStore((s) => s.setup)
  const activeModel = useStore((s) => s.activeModel)
  const settingUp = (activeModel === 'moss' || engine?.mode === 'bundled') && !!setup && setup.state !== 'ready'
  const connected = useStore((s) => s.connected)
  const jobs = useStore((s) => s.jobs)
  const set = useStore((s) => s.set)
  const running = jobs.find((j) => j.status === 'running')
  const queued = jobs.filter((j) => j.status === 'queued').length

  let state = 'starting'
  let text = 'Connecting…'
  if (!connected) {
    state = 'error'
    text = 'Mozaic server not reachable'
  } else if (engine) {
    state = engine.state
    text = engine.state === 'ready' ? `${MODEL_NAMES[(engine.model as ModelId) ?? 'qwen']} ready` : engine.state === 'setup' ? 'Setting up…' : engine.state === 'starting' ? engine.detail || 'Starting engine…' : engine.state === 'error' ? engine.detail : 'Engine stopped'
    if (settingUp) {
      state = setup!.state === 'error' ? 'error' : 'starting'
      text = setup!.state === 'running' ? 'Setting up…' : setup!.state === 'error' ? 'Setup needs attention' : 'Setup paused'
    }
    if (running) {
      state = 'busy'
      text = `${running.phase}${running.steps && running.phase === 'Generating' ? ` ${running.step}/${running.steps}` : ''}`
    }
  }

  return (
    <header className="topbar">
      <div className="brand">
        <MozaicMark size={20} />
        Mozaic
      </div>
      <ModelPicker />
      <div className="spacer" />
      <div className={`engine-pill ${state}`} title={engine?.detail || text}>
        <span className="dot" />
        <span className="txt">{text}</span>
        {queued > 0 && <span className="kbd">+{queued} queued</span>}
      </div>
      {engine && !settingUp && (engine.state === 'stopped' || engine.state === 'error') && (
        <button className="btn sm" onClick={() => api.engine('start')}>
          <Play size={13} /> Start engine
        </button>
      )}
      <button className="btn sm ghost icon" title="Settings (⌘,)" onClick={() => set({ settingsOpen: true })}>
        <Gear size={16} />
      </button>
    </header>
  )
}

function ModelPicker() {
  const active = useStore((s) => s.activeModel)
  const switchModel = useStore((s) => s.switchModel)
  const busy = useStore((s) => s.jobs.some((j) => j.status === 'running'))
  return (
    <div className="model-picker" title={busy ? 'Switching waits for the running job' : 'Only one model is loaded at a time'}>
      {(['qwen', 'moss'] as ModelId[]).map((m) => (
        <button key={m} className={active === m ? 'on' : ''} onClick={() => switchModel(m)}>
          {MODEL_NAMES[m]}
        </button>
      ))}
    </div>
  )
}

export function Rail() {
  const tool = useStore((s) => s.tool)
  const view = useStore((s) => s.view)
  const set = useStore((s) => s.set)
  const tools = MODEL_TOOLS[useStore((s) => s.activeModel)]
  return (
    <nav className="rail">
      {tools.map((t, i) => (
        <button key={t} className={`rail-btn ${view === 'studio' && tool === t ? 'active' : ''}`} onClick={() => set({ tool: t, view: 'studio' })} title={`${TOOL_NAMES[t]} (${i + 1})`}>
          {TOOL_ICONS[t](19)}
          {TOOL_NAMES[t]}
        </button>
      ))}
      <div className="sep" />
      <button className={`rail-btn ${view === 'library' ? 'active' : ''}`} onClick={() => set({ view: view === 'library' ? 'studio' : 'library' })} title="Library (⌘L)">
        <Images size={19} />
        Library
      </button>
    </nav>
  )
}

function JobTile({ job }: { job: Job }) {
  const preview = useStore((s) => s.previews[job.id])
  const set = useStore((s) => s.set)
  const toast = useStore((s) => s.toast)
  if (job.status === 'error')
    return (
      <div className="thumb job err" title={job.error ?? ''} onClick={() => toast(job.error ?? 'Failed', 'error')}>
        <AlertTriangle size={18} />
        <span className="lbl">Failed</span>
      </div>
    )
  const pct = Math.round(job.progress * 100)
  return (
    <div className="thumb job" onClick={() => set({ live: job.id, view: 'studio' })} title={`${job.op}: ${job.phase}`}>
      {preview && <img className="pv" src={preview} alt="" />}
      <svg className="ring" width="34" height="34" viewBox="0 0 34 34">
        <circle cx="17" cy="17" r="14" stroke="var(--line-2)" strokeWidth="3" fill="none" />
        <circle cx="17" cy="17" r="14" stroke="var(--accent)" strokeWidth="3" fill="none" strokeDasharray={`${(pct / 100) * 88} 88`} transform="rotate(-90 17 17)" strokeLinecap="round" />
      </svg>
      <span className="lbl">{job.status === 'queued' ? 'Queued' : `${pct}%`}</span>
      <button
        className="btn sm ghost icon"
        style={{ position: 'absolute', right: 2, top: 2, zIndex: 2 }}
        title="Cancel"
        onClick={(e) => (e.stopPropagation(), api.cancel(job.id))}
      >
        <Square size={11} />
      </button>
    </div>
  )
}

export function Filmstrip() {
  const assets = useStore((s) => s.assets)
  const jobs = useStore((s) => s.jobs)
  const viewing = useStore((s) => s.viewing)
  const show = useStore((s) => s.show)
  const active = jobs.filter((j) => (j.status === 'running' || j.status === 'queued' || (j.status === 'error' && Date.now() / 1000 - (j.finished_at ?? 0) < 120)))
  return (
    <div className="strip">
      {active.map((j) => (
        <JobTile key={j.id} job={j} />
      ))}
      {assets.slice(0, 80).map((a) => (
        <Thumb key={a.id} a={a} active={a.id === viewing} onClick={() => show(a.id)} />
      ))}
      {!assets.length && !active.length && <span className="strip-empty">Your images appear here.</span>}
    </div>
  )
}

export function Thumb({ a, active, onClick }: { a: Asset; active?: boolean; onClick: () => void }) {
  return (
    <div
      className={`thumb ${active ? 'active' : ''} ${a.has_alpha ? 'alpha checker' : ''}`}
      onClick={onClick}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('application/x-mozaic-asset', a.id)}
      title={a.prompt || a.name || a.op}
    >
      <img src={thumbUrl(a.id)} alt="" loading="lazy" draggable={false} />
      {a.favorite && <Star className="star" size={13} fill="currentColor" />}
    </div>
  )
}

const OPS = [
  { v: '', label: 'All' },
  { v: 'generate', label: 'Created' },
  { v: 'edit', label: 'Edited' },
  { v: 'region', label: 'Region' },
  { v: 'expand', label: 'Expanded' },
  { v: 'cutout', label: 'Cut out' },
  { v: 'remix', label: 'Remixed' },
  { v: 'import', label: 'Imported' },
]

function useLibrary(q: string, favorites: boolean, op: string) {
  const [items, setItems] = useState<Asset[]>([])
  const [loading, setLoading] = useState(true)
  const version = useStore((s) => s.assets.length + s.assets.filter((a) => a.favorite).length)
  useEffect(() => {
    let alive = true
    setLoading(true)
    const t = setTimeout(async () => {
      const res = await api.assets({ limit: 600, q, favorites, op })
      if (alive) {
        setItems(res.items)
        setLoading(false)
      }
    }, 150)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [q, favorites, op, version])
  return { items, loading }
}

export function LibraryGrid({ onPick, compact }: { onPick: (a: Asset) => void; compact?: boolean }) {
  const [q, setQ] = useState('')
  const [fav, setFav] = useState(false)
  const [op, setOp] = useState('')
  const { items, loading } = useLibrary(q, fav, op)
  return (
    <div className="library">
      <div className="library-head">
        {!compact && <h2>Library</h2>}
        <div style={{ position: 'relative', flex: 1, maxWidth: 320 }}>
          <Search size={14} style={{ position: 'absolute', left: 9, top: 9, color: 'var(--text-3)' }} />
          <input style={{ paddingLeft: 28 }} placeholder="Search prompts" value={q} onChange={(e) => setQ(e.target.value)} autoFocus={compact} />
        </div>
        <select style={{ width: 130 }} value={op} onChange={(e) => setOp(e.target.value)}>
          {OPS.map((o) => (
            <option key={o.v} value={o.v}>
              {o.label}
            </option>
          ))}
        </select>
        <button className={`btn sm ${fav ? 'on' : ''}`} onClick={() => setFav(!fav)}>
          <Star size={13} /> Starred
        </button>
        <span className="hint" style={{ marginLeft: 'auto' }}>
          {loading ? <Loader2 size={13} className="spin" /> : `${items.length} images`}
        </span>
      </div>
      <div className="library-grid">
        {items.map((a) => (
          <div
            key={a.id}
            className={`card ${a.has_alpha ? 'alpha' : ''}`}
            onClick={() => onPick(a)}
            draggable
            onDragStart={(e) => e.dataTransfer.setData('application/x-mozaic-asset', a.id)}
          >
            <div className={`img ${a.has_alpha ? 'checker' : ''}`}>
              <img src={thumbUrl(a.id)} alt="" loading="lazy" draggable={false} />
              <span className="op">{a.op}</span>
              {a.favorite && <Star className="star" size={14} fill="var(--warm)" color="var(--warm)" style={{ position: 'absolute', right: 7, top: 7 }} />}
            </div>
            <div className="cap">{a.prompt || a.name || `${a.width}×${a.height}`}</div>
          </div>
        ))}
        {!loading && !items.length && <span className="hint">Nothing here yet.</span>}
      </div>
    </div>
  )
}

export function Picker() {
  const pickerFor = useStore((s) => s.pickerFor)
  const set = useStore((s) => s.set)
  const upsertAsset = useStore((s) => s.upsertAsset)
  if (!pickerFor) return null
  const close = () => set({ pickerFor: null })
  const fromDisk = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) return
      const [a] = await api.upload([f])
      upsertAsset(a)
      pickerFor.onPick(a.id)
      close()
    }
    input.click()
  }
  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal wide">
        <div className="modal-head">
          <h2>{pickerFor.title}</h2>
          <button className="btn sm" onClick={fromDisk}>
            Choose file…
          </button>
          <button className="btn sm ghost icon" onClick={close}>
            <X size={15} />
          </button>
        </div>
        <div style={{ position: 'relative', flex: 1 }}>
          <LibraryGrid
            compact
            onPick={(a) => {
              upsertAsset(a)
              pickerFor.onPick(a.id)
              close()
            }}
          />
        </div>
      </div>
    </div>
  )
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  )
}
