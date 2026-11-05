import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, Bot, GripVertical, Images, ListOrdered, Loader2, Pause, Play, Search, Settings as Gear, Star, Square, X } from 'lucide-react'
import { api, thumbUrl, type Asset, type Job } from '../api'
import { MODEL_NAMES, MODEL_TOOLS, WORKSPACE_NAMES, useStore, type ModelId, type Workspace } from '../store'
import { MozaicMark } from './Viewer'
import { OP_TOOL, TOOL_ICONS, TOOL_NAMES } from './actions'

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
  const waiting = queued + (running ? 1 : 0)
  const queueOpen = useStore((s) => s.queueOpen)

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
      <div style={{ position: 'relative' }}>
        <button className={`btn sm queue-toggle ${queueOpen ? 'on' : 'ghost'}`} title="Queue" onClick={() => set({ queueOpen: !queueOpen })}>
          <ListOrdered size={15} /> Queue{waiting > 0 && <span className="count">{waiting}</span>}
        </button>
        {queueOpen && <QueuePanel />}
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

/** What a job is, in the app's own words: the tool it came from and its prompt. */
function jobTitle(j: Job) {
  const tool = j.params.layout ? 'layout' : OP_TOOL[j.op]
  return { tool, name: TOOL_NAMES[tool], prompt: j.params.prompt || j.params.subject || '' }
}

// Falls back to the tool icon when there is no picture yet, or its image has since been deleted.
function QueueThumb({ src, icon }: { src?: string; icon: ReactNode }) {
  const [failed, setFailed] = useState<string | null>(null)
  return <div className="qthumb">{src && failed !== src ? <img src={src} alt="" onError={() => setFailed(src)} /> : icon}</div>
}

/** "4 min", "1 h 35 min": rounded, since these are estimates. */
export function duration(secs: number) {
  const m = Math.max(1, Math.round(secs / 60))
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
}

// Loading the other model takes about this long when the queue switches between Qwen and MOSS.
const SWITCH_SECONDS = 60

function QueuePanel() {
  const jobs = useStore((s) => s.jobs)
  const previews = useStore((s) => s.previews)
  const set = useStore((s) => s.set)
  const show = useStore((s) => s.show)
  const toast = useStore((s) => s.toast)
  // While dragging, the order shown is the one being dragged into; it clears once the server agrees.
  const [order, setOrder] = useState<string[] | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target as HTMLElement).closest('.queue-panel, .queue-toggle')) set({ queueOpen: false })
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', close)
    return () => (window.removeEventListener('pointerdown', close), window.removeEventListener('keydown', close))
  }, [set])
  const running = jobs.filter((j) => j.status === 'running')
  const serverWaiting = jobs.filter((j) => j.status === 'queued' || j.status === 'paused').sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || a.created_at - b.created_at)
  const waiting = order ? (order.map((id) => serverWaiting.find((j) => j.id === id)).filter(Boolean) as Job[]) : serverWaiting
  useEffect(() => {
    if (order && !dragging && serverWaiting.map((j) => j.id).join() === order.join()) setOrder(null)
  }, [order, dragging, serverWaiting])
  const done = jobs.filter((j) => !['running', 'queued', 'paused'].includes(j.status)).slice(0, 8)
  const queued = waiting.filter((j) => j.status === 'queued')
  const paused = waiting.filter((j) => j.status === 'paused')

  // When each queued job should start, adding up the estimates ahead of it. Paused jobs are skipped.
  const startsIn: Record<string, number> = {}
  let clock = running.reduce((t, j) => t + (j.eta ?? 0), 0)
  let model = running[0]?.params.model
  for (const j of queued) {
    if (model && j.params.model !== model) clock += SWITCH_SECONDS
    startsIn[j.id] = clock
    clock += j.eta ?? 0
    model = j.params.model
  }
  const unknown = [...running, ...queued].some((j) => j.eta === null)

  const drop = () => {
    const ids = order
    setDragging(null)
    if (!ids || ids.join() === serverWaiting.map((j) => j.id).join()) return setOrder(null)
    api.reorder(ids).catch((e) => (toast(e.message, 'error'), setOrder(null)))
  }
  const dragOver = (j: Job) => (e: React.DragEvent) => {
    if (!dragging || !e.dataTransfer.types.includes('application/x-mozaic-job')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (j.id === dragging) return
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const ids = waiting.map((x) => x.id).filter((id) => id !== dragging)
    const at = ids.indexOf(j.id) + (e.clientY > r.top + r.height / 2 ? 1 : 0)
    ids.splice(at, 0, dragging)
    if (ids.join() !== waiting.map((x) => x.id).join()) setOrder(ids)
  }

  const row = (j: Job, place?: number) => {
    const t = jobTitle(j)
    const thumb = j.status === 'running' ? previews[j.id] : j.outputs[0] ? thumbUrl(j.outputs[0]) : j.params.image || j.params.images?.[0] ? thumbUrl(j.params.image ?? j.params.images[0]) : undefined
    const secs = j.started_at && j.finished_at ? Math.round(j.finished_at - j.started_at) : 0
    const takes = j.eta !== null ? ` · takes about ${duration(j.eta)}` : ''
    const status =
      j.status === 'running'
        ? `${j.phase}${j.steps && j.phase === 'Generating' ? ` ${j.step}/${j.steps}` : ''}${j.count > 1 ? ` · image ${j.index + 1} of ${j.count}` : ''}${j.eta !== null ? ` · about ${duration(j.eta)} left` : ''}`
        : j.status === 'queued'
          ? `#${place}${startsIn[j.id] !== undefined && !unknown ? ` · starts in about ${duration(startsIn[j.id])}` : ''}${takes}`
          : j.status === 'paused'
            ? `Paused${j.completed ? ` · ${j.completed} of ${j.count} done` : ''}${takes}`
            : j.status === 'done'
              ? `Done · ${j.outputs.length} image${j.outputs.length === 1 ? '' : 's'}${secs ? ` · ${secs < 90 ? `${secs} s` : duration(secs)}` : ''}`
              : j.status === 'error'
                ? j.error || 'Failed'
                : 'Cancelled'
    const open = () => (j.status === 'done' && j.outputs[0] ? show(j.outputs[0]) : j.status === 'running' || j.status === 'queued' ? set({ live: j.id, view: 'studio' }) : null)
    const movable = j.status === 'queued' || j.status === 'paused'
    return (
      <div
        key={j.id}
        className={`queue-row ${j.status} ${dragging === j.id ? 'dragging' : ''}`}
        onClick={open}
        draggable={movable}
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-mozaic-job', j.id)
          e.dataTransfer.effectAllowed = 'move'
          setDragging(j.id)
        }}
        onDragOver={movable ? dragOver(j) : undefined}
        onDrop={(e) => (e.preventDefault(), drop())}
        onDragEnd={drop}
      >
        {movable && (
          <span className="grip" title="Drag to change the order">
            <GripVertical size={14} />
          </span>
        )}
        <QueueThumb src={thumb} icon={TOOL_ICONS[t.tool](16)} />
        <div className="qtext">
          <div className="qtitle">
            {t.name}
            {j.params.model === 'moss' && <span className="badge">MOSS</span>}
            {j.source === 'agent' && (
              <span className="badge" title="Queued by an AI agent over MCP">
                <Bot size={11} /> Agent
              </span>
            )}
          </div>
          {t.prompt && <div className="qprompt">{t.prompt}</div>}
          <div className={`qstatus ${j.status === 'error' ? 'err' : ''}`}>{status}</div>
          {(j.status === 'running' || (j.status === 'paused' && j.progress > 0)) && (
            <div className="bar">
              <i style={{ width: `${Math.round(j.progress * 100)}%` }} />
            </div>
          )}
        </div>
        {(j.status === 'running' || j.status === 'queued') && (
          <button
            className="btn sm ghost icon"
            disabled={j.phase === 'Pausing'}
            title={j.status === 'running' ? 'Pause now. It goes back first in line and keeps the images it finished; the one in progress starts over.' : 'Pause. It stays in the queue but doesn’t run until you resume it.'}
            onClick={(e) => (e.stopPropagation(), api.pause(j.id))}
          >
            <Pause size={14} />
          </button>
        )}
        {j.status === 'paused' && (
          <button className="btn sm ghost icon" title="Resume" onClick={(e) => (e.stopPropagation(), api.resume(j.id))}>
            <Play size={14} />
          </button>
        )}
        {(j.status === 'running' || movable) && (
          <button className="btn sm ghost icon" title={j.status === 'running' ? 'Stop this job' : 'Remove from the queue'} onClick={(e) => (e.stopPropagation(), api.cancel(j.id))}>
            <X size={14} />
          </button>
        )}
      </div>
    )
  }
  const left = clock
  const count = running.length + waiting.length
  return (
    <div className="queue-panel">
      <div className="queue-head">
        <b>Queue</b>
        <span className="hint">
          {count ? `${count} job${count === 1 ? '' : 's'}` : 'Nothing running'}
          {left > 0 && !unknown && ` · about ${duration(left)} left, done around ${new Date(Date.now() + left * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
          {paused.length > 0 && ` · ${paused.length} paused`}
        </span>
      </div>
      {waiting.length > 0 && (
        <div className="queue-actions">
          {queued.length > 0 && (
            <button className="btn sm ghost" title="Hold every waiting job. The running job finishes first; pause it on its own row to stop it now." onClick={() => queued.forEach((j) => api.pause(j.id))}>
              <Pause size={13} /> Pause waiting
            </button>
          )}
          {paused.length > 0 && (
            <button className="btn sm ghost" onClick={() => paused.forEach((j) => api.resume(j.id))}>
              <Play size={13} /> Resume all
            </button>
          )}
          {waiting.length > 1 && (
            <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={() => confirm(`Remove all ${waiting.length} waiting jobs from the queue?`) && waiting.forEach((j) => api.cancel(j.id))}>
              Clear waiting
            </button>
          )}
        </div>
      )}
      {running.map((j) => row(j))}
      {waiting.map((j, i) => row(j, i + 1))}
      {!count && <div className="queue-empty hint">New jobs start right away. While one runs, the Generate button adds to the queue instead.</div>}
      {waiting.length > 1 && <div className="queue-empty hint">Drag waiting jobs to change their order. Times are estimates from how long past jobs took on this Mac.</div>}
      {done.length > 0 && <div className="queue-sub">Recent</div>}
      {done.map((j) => row(j))}
    </div>
  )
}

function ModelPicker() {
  const workspace = useStore((s) => s.workspace)
  const setWorkspace = useStore((s) => s.setWorkspace)
  const busy = useStore((s) => s.jobs.some((j) => j.status === 'running'))
  const titles: Record<Workspace, string> = {
    qwen: busy ? 'Switching waits for the running job' : 'Only one model is loaded at a time',
    moss: busy ? 'Switching waits for the running job' : 'Only one model is loaded at a time',
    traditional: 'Crop, adjust and resize without a model. Queued jobs keep running.',
  }
  return (
    <div className="model-picker">
      {(['qwen', 'moss', 'traditional'] as Workspace[]).map((m) => (
        <button key={m} className={workspace === m ? 'on' : ''} title={titles[m]} onClick={() => setWorkspace(m)}>
          {WORKSPACE_NAMES[m]}
        </button>
      ))}
    </div>
  )
}

export function Rail() {
  const tool = useStore((s) => s.tool)
  const view = useStore((s) => s.view)
  const set = useStore((s) => s.set)
  const tools = MODEL_TOOLS[useStore((s) => s.workspace)]
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
      <span className="lbl">{job.status === 'queued' ? 'Queued' : job.status === 'paused' ? 'Paused' : `${pct}%`}</span>
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
  const active = jobs.filter((j) => (j.status === 'running' || j.status === 'queued' || j.status === 'paused' || (j.status === 'error' && Date.now() / 1000 - (j.finished_at ?? 0) < 120)))
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
  { v: 'adjust', label: 'Adjusted' },
  { v: 'transform', label: 'Rotated / resized' },
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
