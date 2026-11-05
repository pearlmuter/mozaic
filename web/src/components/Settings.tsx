import { useEffect, useState } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { api, native, type Settings as S, type Status } from '../api'
import { useStore } from '../store'
import { Seg, Toggle } from './ui'

// What Mozaic downloads on first use and the terms each comes with. Mozaic ships none of it in the app itself.
const LICENSES: { name: string; license: string; url: string; note?: string }[] = [
  { name: 'Mozaic', license: 'MIT', url: 'https://github.com/pearlmuter/mozaic', note: 'Mozaic’s own code, open source.' },
  {
    name: 'Qwen Image 2.1 (model)',
    license: 'Qwen Research License Agreement',
    url: 'https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE',
    note: 'Non-commercial research and evaluation only; commercial use needs a separate licence from the Qwen team. Qwen is licensed under the Qwen RESEARCH LICENSE AGREEMENT, Copyright (c) 2026 Hangzhou Tongyi Laboratory Technology Co., Ltd. All Rights Reserved.',
  },
  {
    name: 'MOSS-Image (model, Turbo adapters)',
    license: 'Apache-2.0',
    url: 'https://github.com/OpenMOSS/MOSS-Image',
    note: 'Includes the Qwen3.5-9B text encoder (Alibaba Cloud) and the FLUX.2 VAE and small decoder (Black Forest Labs), both Apache-2.0.',
  },
  { name: 'moss-image-mlx', license: 'Apache-2.0', url: 'https://github.com/felix-ab/moss-image-mlx' },
  { name: 'MLX and mlx-lm', license: 'MIT', url: 'https://github.com/ml-explore/mlx' },
  {
    name: 'ComfyUI',
    license: 'GPL-3.0',
    url: 'https://github.com/Comfy-Org/ComfyUI',
    note: 'Downloaded from its official release and run as a separate program to drive Qwen Image 2.1.',
  },
  { name: 'PyTorch', license: 'BSD-3-Clause', url: 'https://github.com/pytorch/pytorch' },
]

function CopyBlock({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <div className="code" style={{ paddingRight: 40 }}>{text}</div>
      <button
        className="btn sm ghost icon"
        style={{ position: 'absolute', right: 5, top: 5 }}
        title="Copy"
        onClick={async () => {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        }}
      >
        {done ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  )
}

export function SettingsModal() {
  const open = useStore((s) => s.settingsOpen)
  const set = useStore((s) => s.set)
  const models = useStore((s) => s.models)
  const engine = useStore((s) => s.engine)
  const loadModels = useStore((s) => s.loadModels)
  const toast = useStore((s) => s.toast)
  const [draft, setDraft] = useState<S | null>(null)
  const [status, setStatus] = useState<Status | null>(null)

  useEffect(() => {
    if (!open) return
    api.settings().then(setDraft)
    api.status().then(setStatus)
    loadModels()
  }, [open, loadModels])

  if (!open || !draft) return null
  const p = (v: Partial<S>) => setDraft({ ...draft, ...v })
  const close = () => set({ settingsOpen: false })
  const save = async () => {
    const saved = await api.saveSettings(draft)
    set({ settings: saved })
    toast('Settings saved', 'success')
    close()
  }

  const stdio = status?.mcp_command ?? []
  const httpUrl = status?.mcp_url ?? 'http://127.0.0.1:47811/mcp'
  const claudeCode = `claude mcp add --transport http mozaic ${httpUrl}`
  const claudeCodeStdio = stdio.length ? `claude mcp add mozaic -- ${stdio.map((x) => (x.includes(' ') ? `"${x}"` : x)).join(' ')}` : ''
  const desktopJson = JSON.stringify({ mcpServers: { mozaic: { command: stdio[0], args: stdio.slice(1) } } }, null, 2)

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal">
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="btn sm ghost icon" onClick={close}>
            <X size={15} />
          </button>
        </div>
        <div className="modal-body">
          <section className="settings-section">
            <h3>Engine</h3>
            <div className="field" style={{ marginBottom: 12 }}>
              <label>Engine</label>
              <Seg
                value={draft.comfy_mode}
                onChange={(v) => p({ comfy_mode: v })}
                options={[
                  { v: 'bundled', label: 'Built in' },
                  { v: 'custom', label: 'Another ComfyUI folder' },
                  { v: 'external', label: 'A running ComfyUI' },
                ]}
              />
              <span className="hint">
                {draft.comfy_mode === 'bundled' && 'Mozaic’s own ComfyUI and models, kept in ~/Library/Application Support/Mozaic.'}
                {draft.comfy_mode === 'custom' && 'Run a ComfyUI install you manage yourself, headless. It needs Qwen Image 2.1 support (v0.37+).'}
                {draft.comfy_mode === 'external' && 'Connect to a ComfyUI that is already running, here or on another machine.'}
              </span>
            </div>
            {draft.comfy_mode === 'custom' && (
              <div className="field">
                <label>ComfyUI folder</label>
                <input value={draft.comfy_path} placeholder="/path/to/ComfyUI" onChange={(e) => p({ comfy_path: e.target.value })} />
              </div>
            )}
            {draft.comfy_mode === 'external' && (
              <div className="field">
                <label>ComfyUI URL</label>
                <input value={draft.comfy_url} placeholder="http://127.0.0.1:8188" onChange={(e) => p({ comfy_url: e.target.value })} />
              </div>
            )}
            {draft.comfy_mode !== 'external' && (
              <div className="grid2" style={{ marginTop: 12 }}>
                <div className="field" style={{ gridColumn: 'span 2' }}>
                  <label>Extra model folders (one per line, optional)</label>
                  <textarea style={{ minHeight: 50 }} value={draft.models_dirs.join('\n')} placeholder="e.g. a folder with LoRAs" onChange={(e) => p({ models_dirs: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} />
                </div>
                <div className="field">
                  <label>Engine port</label>
                  <input type="number" value={draft.comfy_port} onChange={(e) => p({ comfy_port: Number(e.target.value) })} />
                </div>
              </div>
            )}
            <div style={{ marginTop: 12 }}>
              <Toggle on={draft.auto_start_engine} onChange={(v) => p({ auto_start_engine: v })} label="Start the engine when Mozaic opens" />
            </div>
            <div className="row" style={{ marginTop: 12, gap: 6, flex: 'none' }}>
              <span className="hint" style={{ flex: 1 }}>
                Status: {engine?.state}
                {engine?.detail ? ` — ${engine.detail}` : ''}
              </span>
              <button className="btn sm" style={{ flex: 'none' }} onClick={() => api.engine('restart')}>Restart</button>
              <button className="btn sm" style={{ flex: 'none' }} onClick={() => api.engine('stop')}>Stop</button>
              <button className="btn sm" style={{ flex: 'none' }} title="Unload models from memory" onClick={() => api.engine('free').then(() => toast('Models unloaded'))}>
                Free memory
              </button>
            </div>
          </section>

          <section className="settings-section">
            <h3>Models</h3>
            {!models && <span className="hint">Model lists appear once the engine is ready.</span>}
            {models && (
              <div className="grid2">
                <div className="field">
                  <label>Image model</label>
                  <select value={draft.unet} onChange={(e) => p({ unet: e.target.value })}>
                    <option value="">Auto ({models.selected.unet ?? 'none found'})</option>
                    {models.unet.map((x) => <option key={x}>{x}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>Weight dtype</label>
                  <select value={draft.weight_dtype} onChange={(e) => p({ weight_dtype: e.target.value })}>
                    {(models.weight_dtypes.length ? models.weight_dtypes : ['default']).map((x) => <option key={x}>{x}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>Text encoder</label>
                  <select value={draft.text_encoder} onChange={(e) => p({ text_encoder: e.target.value })}>
                    <option value="">Auto ({models.selected.text_encoder ?? 'none found'})</option>
                    {models.text_encoder.map((x) => <option key={x}>{x}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>VAE</label>
                  <select value={draft.vae} onChange={(e) => p({ vae: e.target.value })}>
                    <option value="">Auto ({models.selected.vae ?? 'none found'})</option>
                    {models.vae.map((x) => <option key={x}>{x}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>KV cache location</label>
                  <select value={draft.cache_device} onChange={(e) => p({ cache_device: e.target.value })}>
                    <option value="auto">Auto</option>
                    <option value="gpu">GPU</option>
                    <option value="cpu">RAM</option>
                    <option value="off">Off (recompute)</option>
                  </select>
                </div>
                <div className="field">
                  <label>KV cache precision</label>
                  <select value={draft.cache_dtype} onChange={(e) => p({ cache_dtype: e.target.value })}>
                    <option value="default">Lossless</option>
                    <option value="int8">int8 (half memory)</option>
                    <option value="int4">int4 (quarter memory)</option>
                  </select>
                </div>
              </div>
            )}
          </section>

          <section className="settings-section">
            <h3>MOSS-Image</h3>
            <div className="field" style={{ marginBottom: 12 }}>
              <label>Default checkpoint (for agents and the API)</label>
              <Seg
                value={draft.moss_checkpoint}
                onChange={(v) => p({ moss_checkpoint: v })}
                options={[
                  { v: 'sft', label: 'SFT (polished)' },
                  { v: 'base', label: 'Base (less curated)' },
                ]}
              />
            </div>
            <Toggle
              on={draft.moss_keep_resident}
              onChange={(v) => p({ moss_keep_resident: v })}
              label="Keep MOSS loaded between images"
              hint="Faster back-to-back images; uses about 18 GB while MOSS is active instead of loading parts per image (~10 GB peak)."
            />
          </section>

          <section className="settings-section">
            <h3>Defaults for agents and the API</h3>
            <div className="grid2">
              <div className="field">
                <label>Steps</label>
                <input type="number" value={draft.steps} onChange={(e) => p({ steps: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>Megapixels</label>
                <input type="number" step={0.25} value={draft.megapixels} onChange={(e) => p({ megapixels: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>Sampler</label>
                <select value={draft.sampler} onChange={(e) => p({ sampler: e.target.value })}>
                  {(models?.samplers ?? [draft.sampler]).map((x) => <option key={x}>{x}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Scheduler</label>
                <select value={draft.scheduler} onChange={(e) => p({ scheduler: e.target.value })}>
                  {(models?.schedulers ?? [draft.scheduler]).map((x) => <option key={x}>{x}</option>)}
                </select>
              </div>
              <div className="field" style={{ gridColumn: 'span 2' }}>
                <label>Library folder</label>
                <input value={draft.library_dir} onChange={(e) => p({ library_dir: e.target.value })} />
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h3>MCP: let an AI use Mozaic</h3>
            <p className="hint" style={{ marginBottom: 10 }}>
              Agents get tools to create, edit, cut out, expand and remix images, browse the library and write prompts. Their jobs show up here live.
            </p>
            <div className="field">
              <label>HTTP endpoint (while Mozaic is open)</label>
              <CopyBlock text={httpUrl} />
            </div>
            <div className="field" style={{ marginTop: 10 }}>
              <label>Claude Code</label>
              <CopyBlock text={claudeCode} />
              {claudeCodeStdio && <CopyBlock text={claudeCodeStdio} />}
              <span className="hint">The second form also works when Mozaic is closed: it starts a headless Mozaic that quits after 30 idle minutes.</span>
            </div>
            {stdio.length > 0 && (
              <div className="field" style={{ marginTop: 10 }}>
                <label>Claude Desktop and other stdio clients</label>
                <CopyBlock text={desktopJson} />
              </div>
            )}
          </section>

          <section className="settings-section">
            <h3>Licences</h3>
            <p className="hint" style={{ marginBottom: 10 }}>
              Mozaic downloads the models and engines below on first use. Each keeps its own licence, and the models' terms apply to what you make with them.
            </p>
            <div className="licenses">
              {LICENSES.map((l) => (
                <div key={l.name} className="license">
                  <div className="row">
                    <b>{l.name}</b>
                    <a
                      href={l.url}
                      onClick={(e) => {
                        e.preventDefault()
                        native.openUrl(l.url)
                      }}
                    >
                      {l.license}
                    </a>
                  </div>
                  {l.note && <span className="hint">{l.note}</span>}
                </div>
              ))}
            </div>
          </section>
        </div>
        <div className="inspector-foot" style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  )
}
