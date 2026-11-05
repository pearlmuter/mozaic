import { AlertTriangle, Check, Download, HardDrive, Link2, Loader2, Pause, Play, RotateCcw } from 'lucide-react'
import { api, type SetupStatus } from '../api'
import { useStore } from '../store'
import { MozaicMark } from './Viewer'

const gb = (b: number) => `${(b / 1e9).toFixed(b >= 10e9 ? 0 : 1)} GB`

function eta(s: SetupStatus) {
  if (!s.speed || s.step !== 'models') return ''
  const left = s.to_download - s.downloaded
  if (left <= 0) return ''
  const secs = left / s.speed
  const m = Math.round(secs / 60)
  return m >= 60 ? `about ${Math.floor(m / 60)} h ${m % 60} min left` : m >= 1 ? `about ${m} min left` : 'less than a minute left'
}

export function SetupScreen() {
  const s = useStore((st) => st.setup)
  if (!s) return null
  const running = s.state === 'running'
  const reusing = s.files.filter((f) => f.source)
  const engineState = s.engine_ready ? 'done' : running && s.step === 'engine' ? 'active' : 'pending'
  const modelsState = s.models_ready ? 'done' : running && s.step === 'models' ? 'active' : 'pending'
  const modelPct = s.to_download ? s.downloaded / s.to_download : s.files.filter((f) => f.state === 'done').length / s.files.length

  return (
    <div className="setup">
      <div className="setup-card">
        <div className="setup-head">
          <MozaicMark size={40} />
          <div>
            <h1>Setting up {s.title || 'Mozaic'}</h1>
            <p>
              A one-time install of its engine and model files.
              {s.to_download > 0 ? ` About ${gb(s.to_download + (s.engine_ready ? 0 : s.engine_size))} to download.` : ''}
            </p>
          </div>
        </div>

        {s.warnings.map((w) => (
          <div key={w} className="setup-warn">
            <AlertTriangle size={15} /> {w}
          </div>
        ))}

        <div className={`setup-step ${engineState}`}>
          <StepIcon state={engineState} />
          <div className="setup-step-body">
            <div className="setup-step-title">
              Engine <span className="hint">{s.engine_label} · about {gb(s.engine_size)}</span>
            </div>
            {engineState === 'active' && (
              <>
                <div className="bar wide">
                  <i style={{ width: `${Math.round(s.engine_progress * 100)}%` }} />
                </div>
                <div className="setup-detail">{s.detail}</div>
              </>
            )}
          </div>
        </div>

        <div className={`setup-step ${modelsState}`}>
          <StepIcon state={modelsState} />
          <div className="setup-step-body">
            <div className="setup-step-title">
              {s.title} model{' '}
              <span className="hint">{gb(s.files.reduce((a, f) => a + f.size, 0))}</span>
            </div>
            {reusing.length > 0 && !s.models_ready && (
              <div className="setup-detail wrap">
                <Link2 size={12} style={{ verticalAlign: -2 }} /> Reusing {reusing.length === s.files.length ? 'all model files' : `${reusing.length} file${reusing.length > 1 ? 's' : ''}`} already on this Mac (no extra space; safe if the other app is removed).
              </div>
            )}
            <div className="setup-files">
              {groupFiles(s.files).map((f) => (
                <div key={f.name} className="setup-file">
                  <span className="name">{f.label}</span>
                  <span className="size">
                    {f.state === 'done' ? (
                      <Check size={13} color="var(--accent)" />
                    ) : f.state === 'downloading' ? (
                      `${gb(f.done)} / ${gb(f.size)}`
                    ) : f.source ? (
                      'on this Mac'
                    ) : (
                      gb(f.size)
                    )}
                  </span>
                </div>
              ))}
            </div>
            {modelsState === 'active' && s.to_download > 0 && (
              <>
                <div className="bar wide">
                  <i style={{ width: `${Math.round(modelPct * 100)}%` }} />
                </div>
                <div className="setup-detail">
                  {s.detail}
                  {s.speed ? ` · ${(s.speed / 1e6).toFixed(1)} MB/s` : ''} {eta(s) && `· ${eta(s)}`}
                </div>
              </>
            )}
          </div>
        </div>

        {s.error && (
          <div className="job-error" style={{ whiteSpace: 'pre-wrap' }}>
            {s.error}
          </div>
        )}

        <div className="setup-foot">
          <span className="hint">
            <HardDrive size={12} style={{ verticalAlign: -2 }} /> {gb(s.disk_free)} free{s.disk_needed ? ` · needs ${gb(s.disk_needed)}` : ''} · {s.ram_gb.toFixed(0)} GB memory
          </span>
          {running ? (
            <button className="btn" onClick={() => api.setupCancel()}>
              <Pause size={14} /> Pause
            </button>
          ) : (
            <button className="btn primary" onClick={() => api.setupStart()}>
              {s.error ? <RotateCcw size={14} /> : s.detail === 'Paused' ? <Play size={14} /> : <Download size={14} />}
              {s.error ? 'Retry' : s.detail === 'Paused' ? 'Resume' : 'Install'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Shards of one component (and small config files) shown as one line. */
function groupFiles(files: SetupStatus['files']) {
  const groups = new Map<string, SetupStatus['files'][number]>()
  for (const f of files) {
    if (f.size < 50e6) continue
    const g = groups.get(f.label)
    if (!g) groups.set(f.label, { ...f })
    else {
      g.size += f.size
      g.done += f.done
      g.state = g.state === 'done' && f.state === 'done' ? 'done' : f.state === 'downloading' || g.state === 'downloading' ? 'downloading' : g.state === 'done' ? f.state : g.state
      g.source = g.source && f.source
    }
  }
  return [...groups.values()]
}

function StepIcon({ state }: { state: string }) {
  return (
    <span className={`setup-icon ${state}`}>
      {state === 'done' ? <Check size={14} /> : state === 'active' ? <Loader2 size={14} className="spin" /> : null}
    </span>
  )
}
