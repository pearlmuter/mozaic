import { useEffect, useState } from 'react'
import { api } from './api'
import { MODEL_TOOLS, useStore, type Tool } from './store'
import { Filmstrip, LibraryGrid, Picker, Rail, Toasts, TopBar } from './components/Chrome'
import { Inspector, runTool } from './components/Inspector'
import { Viewer } from './components/Viewer'
import { SettingsModal } from './components/Settings'
import { SetupScreen } from './components/Setup'
import { importFiles } from './components/actions'
import { undo } from './components/maskState'

function useEvents() {
  useEffect(() => {
    let ws: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout>
    let closed = false
    const s = useStore.getState
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`)
      ws.onopen = () => {
        s().set({ connected: true })
        s().loadAssets()
      }
      ws.onclose = () => {
        s().set({ connected: false })
        if (!closed) retry = setTimeout(connect, 1500)
      }
      ws.onmessage = (m) => {
        const e = JSON.parse(m.data)
        const st = s()
        if (e.type === 'hello') {
          st.applyEngines(e.active_model, e.engines, e.setups)
          e.jobs.forEach((j: any) => st.upsertJob(j))
          if (e.engines[e.active_model]?.state === 'ready') st.loadModels()
        } else if (e.type === 'engine') {
          const wasReady = st.engines[e.model as 'qwen' | 'moss']?.state === 'ready'
          st.applyEngines(st.activeModel, { [e.model]: e.engine })
          if (e.model === st.activeModel && e.engine.state === 'ready' && !wasReady) st.loadModels()
        } else if (e.type === 'setup') st.applyEngines(st.activeModel, {}, { [e.model]: e.setup })
        else if (e.type === 'active_model') {
          st.applyEngines(e.model, {})
          st.loadModels()
        }
        else if (e.type === 'job') st.upsertJob(e.job)
        else if (e.type === 'preview') st.set({ previews: { ...st.previews, [e.job_id]: e.image } })
        else if (e.type === 'asset' || e.type === 'asset_updated') st.upsertAsset(e.asset)
        else if (e.type === 'asset_deleted') st.removeAsset(e.id)
      }
    }
    connect()
    return () => {
      closed = true
      clearTimeout(retry)
      ws?.close()
    }
  }, [])
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState()
      const typing = !!(e.target as HTMLElement).closest('textarea, input, select')
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (s.view === 'studio') runTool(s.tool)
        return
      }
      if (e.metaKey && e.key === ',') {
        e.preventDefault()
        s.set({ settingsOpen: true })
        return
      }
      if (e.metaKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        s.newImage()
        return
      }
      if (e.metaKey && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        s.set({ view: s.view === 'library' ? 'studio' : 'library' })
        return
      }
      if (e.key === 'Escape') {
        if (s.pickerFor) s.set({ pickerFor: null })
        else if (s.settingsOpen) s.set({ settingsOpen: false })
        else if (s.view === 'library') s.set({ view: 'studio' })
        return
      }
      if (typing || s.pickerFor || s.settingsOpen) return
      const painting = s.tool === 'region' && s.region.image === s.viewing
      if (e.metaKey && e.key.toLowerCase() === 'z' && painting) {
        e.preventDefault()
        undo()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const tools: Tool[] = MODEL_TOOLS[s.activeModel]
      if (/^[1-9]$/.test(e.key) && tools[Number(e.key) - 1]) s.set({ tool: tools[Number(e.key) - 1], view: 'studio' })
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const i = s.assets.findIndex((a) => a.id === s.viewing)
        const next = s.assets[Math.max(0, Math.min(s.assets.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))]
        if (next) s.show(next.id)
      } else if (e.key === 'f') window.dispatchEvent(new Event('mozaic:fit'))
      else if (e.key === 'c') s.set({ compare: !s.compare })
      else if (e.key === 's' && s.viewing) {
        const a = s.assetMap[s.viewing]
        if (a) api.patch(a.id, { favorite: !a.favorite }).then(s.upsertAsset)
      } else if (painting) {
        const map: Record<string, any> = { b: 'brush', e: 'eraser', r: 'rect', o: 'ellipse', l: 'lasso' }
        if (map[e.key]) s.patch('mask', { tool: map[e.key] })
        else if (e.key === '[') s.patch('mask', { size: Math.max(4, Math.round(s.mask.size / 1.2)) })
        else if (e.key === ']') s.patch('mask', { size: Math.min(400, Math.round(s.mask.size * 1.2)) })
      }
    }
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement).closest('textarea, input')) return
      const files = [...(e.clipboardData?.files ?? [])]
      if (files.length) {
        e.preventDefault()
        importFiles(files)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('paste', onPaste)
    return () => (window.removeEventListener('keydown', onKey), window.removeEventListener('paste', onPaste))
  }, [])
}

function useFileDrop() {
  const [over, setOver] = useState(false)
  useEffect(() => {
    let depth = 0
    const isFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files')
    const enter = (e: DragEvent) => {
      if (!isFiles(e)) return
      depth++
      setOver(true)
    }
    const leave = (e: DragEvent) => {
      if (!isFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (!depth) setOver(false)
    }
    const overFn = (e: DragEvent) => isFiles(e) && e.preventDefault()
    const drop = (e: DragEvent) => {
      depth = 0
      setOver(false)
      if (!isFiles(e) || e.defaultPrevented) return
      e.preventDefault()
      importFiles([...(e.dataTransfer?.files ?? [])])
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', overFn)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', overFn)
      window.removeEventListener('drop', drop)
    }
  }, [])
  return over
}

export default function App() {
  const view = useStore((s) => s.view)
  const show = useStore((s) => s.show)
  const set = useStore((s) => s.set)
  const setup = useStore((s) => s.setup)
  const engine = useStore((s) => s.engine)
  const activeModel = useStore((s) => s.activeModel)
  useEvents()
  useShortcuts()
  const dropping = useFileDrop()

  return (
    <div className={`app ${view === 'library' ? 'library-view' : ''} ${(window as any).webkit?.messageHandlers?.mozaic ? 'native' : ''}`}>
      <TopBar />
      <Rail />
      <main className="stage">
        {view === 'library' ? (
          <LibraryGrid
            onPick={(a) => {
              useStore.getState().upsertAsset(a)
              show(a.id)
              set({ view: 'studio' })
            }}
          />
        ) : (
          <Viewer />
        )}
      </main>
      {view === 'studio' && <Inspector />}
      {view === 'studio' && <Filmstrip />}
      <Picker />
      {setup && setup.state !== 'ready' && (activeModel === 'moss' || engine?.mode === 'bundled') && <SetupScreen />}
      <SettingsModal />
      <Toasts />
      {dropping && (
        <div className="drop-overlay">
          <div>Drop images to import</div>
        </div>
      )}
    </div>
  )
}
