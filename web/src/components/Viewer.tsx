import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Brush, Circle, Columns2, Copy, Download, Eraser, FolderOpen, Lasso, Loader2, Maximize, Minus, Plus, RotateCcw,
  Scan, Square, Star, Trash2, Undo2, X, ImageUp, History, ImagePlus,
} from 'lucide-react'
import { api, fileUrl, native } from '../api'
import { useStore, type Tool } from '../store'
import { clearMask, fillShape, invertMask, maskCanvas, snapshot, strokeDone, strokeLine, undo } from './maskState'
import { reuseSettings, straighten, TOOL_ICONS, TOOL_NAMES } from './actions'
import { LayoutCanvas } from './LayoutCanvas'
import { AdjustCanvas } from './Traditional'

type Pt = { x: number; y: number }

export function Viewer() {
  const viewing = useStore((s) => s.viewing)
  const live = useStore((s) => s.live)
  const previews = useStore((s) => s.previews)
  const jobs = useStore((s) => s.jobs)
  const tool = useStore((s) => s.tool)
  const region = useStore((s) => s.region)
  const expand = useStore((s) => s.expand)
  const adjustImage = useStore((s) => s.adjust.image)
  const workspace = useStore((s) => s.workspace)
  const compare = useStore((s) => s.compare)
  const layoutView = useStore((s) => s.layoutView)
  const assetMap = useStore((s) => s.assetMap)
  const mask = useStore((s) => s.mask)
  const set = useStore((s) => s.set)
  const patch = useStore((s) => s.patch)

  const liveJob = live ? jobs.find((j) => j.id === live) : undefined
  const showLive = !!liveJob && (liveJob.status === 'running' || liveJob.status === 'queued')
  const asset = viewing ? assetMap[viewing] : undefined
  const previewSrc = showLive ? previews[liveJob!.id] : undefined
  const parent = asset?.parents[0] ? assetMap[asset.parents[0]] : undefined

  const painting = tool === 'region' && !showLive && !!asset && region.image === asset.id
  const cropping = tool === 'crop' && workspace === 'traditional'
  const expanding = (tool === 'expand' || cropping) && !showLive && !!asset && expand.image === asset.id
  const adjusting = tool === 'adjust' && workspace === 'traditional' && !showLive && !!asset && adjustImage === asset.id

  const [natural, setNatural] = useState<{ w: number; h: number }>({ w: 1024, h: 1024 })
  const [view, setView] = useState({ s: 1, x: 0, y: 0 })
  const [cursor, setCursor] = useState<Pt | null>(null)
  const [shape, setShape] = useState<Pt[] | null>(null)
  const [split, setSplit] = useState(0.5)
  const [space, setSpace] = useState(false)
  const [panning, setPanning] = useState(false)

  const stageRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const maskHost = useRef<HTMLDivElement>(null)
  const drag = useRef<{ kind: string; start: Pt; last: Pt; view?: typeof view; side?: string; value?: number } | null>(null)

  // Until the first preview arrives, a running job shows its input image (dimmed) or a blank canvas of its size.
  const liveInput = showLive && !previewSrc ? assetMap[liveJob!.params.image ?? liveJob!.params.images?.[0] ?? ''] : undefined
  const liveSize = liveInput ? { w: liveInput.width, h: liveInput.height } : showLive && !previewSrc && liveJob!.params.width ? { w: liveJob!.params.width, h: liveJob!.params.height } : natural
  const W = asset && !showLive ? asset.width : liveSize.w
  const H = asset && !showLive ? asset.height : liveSize.h
  const ex = expanding ? expand : { left: 0, top: 0, right: 0, bottom: 0 }
  const angle = expanding ? expand.angle : 0
  const leveling = expanding && expand.leveling
  const [level, setLevel] = useState<[Pt, Pt] | null>(null)

  const fit = useCallback(() => {
    const el = stageRef.current
    if (!el) return
    const cw = el.clientWidth
    const ch = el.clientHeight
    // Fit the photo and the frame together, so a crop still shows what it cuts away.
    const [l, t, r, b] = [ex.left, ex.top, ex.right, ex.bottom].map((v) => Math.max(0, v))
    const fw = W + l + r
    const fh = H + t + b
    const s = Math.min((cw - 80) / fw, (ch - 110) / fh, showLive ? 8 : 2)
    setView({ s, x: (cw - fw * s) / 2 + l * s, y: (ch - fh * s) / 2 + t * s + 10 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [W, H, expanding, showLive, ex.left, ex.right, ex.top, ex.bottom])

  useLayoutEffect(() => {
    fit()
    // Refit when the image or mode changes, not on every expand nudge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset?.id, showLive, W, H, expanding, tool, layoutView])

  useEffect(() => {
    const on = () => fit()
    window.addEventListener('resize', on)
    window.addEventListener('mozaic:fit', on)
    return () => (window.removeEventListener('resize', on), window.removeEventListener('mozaic:fit', on))
  }, [fit])

  // Mount the shared mask canvas into the stage.
  useEffect(() => {
    if (!painting || !asset || !maskHost.current) return
    const c = maskCanvas(asset.id, asset.width, asset.height)
    c.className = 'mask-canvas'
    c.style.width = `${asset.width}px`
    c.style.height = `${asset.height}px`
    maskHost.current.replaceChildren(c)
  }, [painting, asset])

  // Wheel: pinch / ⌘-scroll zooms around the cursor, plain scroll pans.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      setView((v) => {
        if (e.ctrlKey || e.metaKey) {
          const s = Math.min(16, Math.max(0.05, v.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002))))
          return { s, x: mx - ((mx - v.x) * s) / v.s, y: my - ((my - v.y) * s) / v.s }
        }
        return { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // The stage element only exists outside the layout editor, so re-attach when that changes.
  }, [tool, layoutView])

  // Space to pan while painting.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target as HTMLElement).closest('textarea,input')) {
        e.preventDefault()
        setSpace(true)
      }
    }
    const up = (e: KeyboardEvent) => e.code === 'Space' && setSpace(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => (window.removeEventListener('keydown', down), window.removeEventListener('keyup', up))
  }, [])

  const toImage = (e: { clientX: number; clientY: number }): Pt => {
    const r = wrapRef.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / view.s, y: (e.clientY - r.top) / view.s }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.stage-toolbar,.zoom-ctl,.stage-info,.live-badge,.layout-switch')) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const p = toImage(e)
    if (painting && e.button === 0 && !space) {
      snapshot()
      const t = mask.tool
      if (t === 'brush' || t === 'eraser') {
        strokeLine(p.x, p.y, p.x, p.y, mask.size, t === 'eraser')
        drag.current = { kind: 'paint', start: p, last: p }
      } else {
        drag.current = { kind: 'shape', start: p, last: p }
        setShape([p])
      }
      return
    }
    if (leveling && e.button === 0 && !space) {
      drag.current = { kind: 'level', start: p, last: p }
      setLevel([p, p])
      return
    }
    setPanning(true)
    drag.current = { kind: 'pan', start: { x: e.clientX, y: e.clientY }, last: p, view }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (painting) {
      const r = stageRef.current!.getBoundingClientRect()
      setCursor({ x: e.clientX - r.left, y: e.clientY - r.top })
    }
    const d = drag.current
    if (!d) return
    if (d.kind === 'pan' && d.view) {
      setView({ ...d.view, x: d.view.x + e.clientX - d.start.x, y: d.view.y + e.clientY - d.start.y })
    } else if (d.kind === 'paint') {
      const p = toImage(e)
      strokeLine(d.last.x, d.last.y, p.x, p.y, mask.size, mask.tool === 'eraser')
      d.last = p
    } else if (d.kind === 'shape') {
      const p = toImage(e)
      setShape((s) => (mask.tool === 'lasso' ? [...(s ?? []), p] : [d.start, p]))
    } else if (d.kind === 'level') {
      setLevel([d.start, toImage(e)])
    } else if (d.kind === 'expand' && d.side) {
      const across = d.side === 'left' || d.side === 'right'
      const delta = (across ? e.clientX - d.start.x : e.clientY - d.start.y) / view.s
      const sign = d.side === 'left' || d.side === 'top' ? -1 : 1
      const raw = (d.value ?? 0) + sign * delta
      // Growing snaps to 16 px for the model; cropping follows the pointer.
      const opposite = { left: expand.right, right: expand.left, top: expand.bottom, bottom: expand.top }[d.side as 'left' | 'right' | 'top' | 'bottom']
      // Growing snaps to 16 px for the model; Crop only ever cuts in.
      const value = Math.max(64 - (across ? W : H) - opposite, cropping ? Math.min(0, Math.round(raw)) : raw > 0 ? Math.round(raw / 16) * 16 : Math.round(raw))
      const next = { ...expand, [d.side]: value }
      patch('expand', { [d.side]: value, ratio: (W + next.left + next.right) / (H + next.top + next.bottom) })
    } else if (d.kind === 'split') {
      const r = wrapRef.current!.getBoundingClientRect()
      setSplit(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)))
    }
  }

  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    setPanning(false)
    if (!d) return
    if (d.kind === 'paint') strokeDone()
    if (d.kind === 'level' && level) {
      setLevel(null)
      const [a, b] = level
      if (Math.hypot(b.x - a.x, b.y - a.y) * view.s < 12) return
      // Turn the drawn line level, or upright when it is closer to vertical.
      let phi = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
      if (phi > 90) phi -= 180
      if (phi <= -90) phi += 180
      const delta = Math.abs(phi) <= 45 ? -phi : (phi > 0 ? 90 : -90) - phi
      patch('expand', { leveling: false })
      straighten(expand.angle + delta)
    }
    if (d.kind === 'shape' && shape) {
      const t = mask.tool as 'rect' | 'ellipse' | 'lasso'
      fillShape(t, shape, false)
      setShape(null)
      strokeDone()
    }
  }

  const startExpandDrag = (side: 'left' | 'right' | 'top' | 'bottom') => (e: React.PointerEvent) => {
    e.stopPropagation()
    ;(stageRef.current as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { kind: 'expand', start: { x: e.clientX, y: e.clientY }, last: { x: 0, y: 0 }, side, value: expand[side] }
  }

  const zoomBy = (f: number) => {
    const el = stageRef.current!
    const mx = el.clientWidth / 2
    const my = el.clientHeight / 2
    setView((v) => {
      const s = Math.min(16, Math.max(0.05, v.s * f))
      return { s, x: mx - ((mx - v.x) * s) / v.s, y: my - ((my - v.y) * s) / v.s }
    })
  }

  const actual = () => {
    const el = stageRef.current!
    setView({ s: 1, x: (el.clientWidth - W) / 2, y: (el.clientHeight - H) / 2 })
  }

  const src = showLive ? (previewSrc ?? (liveInput ? fileUrl(liveInput.id) : undefined)) : asset ? fileUrl(asset.id) : undefined
  // Qwen's live preview is one colour per 16×16 block; soften it so it reads as a draft rather than noise.
  const previewBlur = previewSrc && natural.w ? Math.min(12, (W / natural.w) * 0.45) : 0
  const showCompare = compare && !!parent && !showLive && !painting && !expanding && !adjusting

  if (tool === 'layout' && !showLive && layoutView === 'edit') return <LayoutCanvas />

  const cls = ['viewer', painting && !space ? '' : panning ? 'grabbing' : 'grab'].join(' ')

  return (
    <div
      className={cls}
      ref={stageRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setCursor(null)}
      style={{ cursor: painting && !space ? 'none' : leveling && !space ? 'crosshair' : undefined }}
    >
      {!src && !showLive && <EmptyStage />}

      {(src || showLive) && (
        <div ref={wrapRef} className="canvas-wrap" style={{ width: W, height: H, transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}>
          {expanding && (
            <div
              className="expand-frame checker"
              style={{ left: -ex.left, top: -ex.top, width: W + ex.left + ex.right, height: H + ex.top + ex.bottom, borderWidth: 2 / view.s }}
            />
          )}
          <div className={`shadow ${asset?.has_alpha && !showLive ? 'checker' : ''}`} style={{ width: W, height: H, transform: angle ? `rotate(${angle}deg)` : undefined }} />
          {showCompare && parent && (
            <img src={fileUrl(parent.id)} style={{ width: W, height: H, objectFit: 'fill', clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` }} draggable={false} alt="" />
          )}
          {adjusting ? (
            <AdjustCanvas id={asset!.id} w={W} h={H} />
          ) : src ? (
            <img
              key={src.length > 200 ? 'live' : src}
              src={src}
              alt=""
              draggable={false}
              style={{
                width: W,
                height: H,
                clipPath: showCompare ? `inset(0 0 0 ${split * 100}%)` : undefined,
                transform: angle ? `rotate(${angle}deg)` : undefined,
                opacity: liveInput ? 0.35 : 1,
                filter: liveInput ? 'grayscale(0.6)' : previewBlur ? `blur(${previewBlur}px) saturate(1.1)` : undefined,
              }}
              onLoad={(e) => previewSrc && setNatural({ w: (e.target as HTMLImageElement).naturalWidth, h: (e.target as HTMLImageElement).naturalHeight })}
            />
          ) : (
            <div className="live-canvas" style={{ width: W, height: H }} />
          )}
          {painting && <div ref={maskHost} style={{ position: 'absolute', inset: 0 }} />}
          {expanding && (
            <div
              className={`crop-frame ${angle || leveling ? 'grid' : ''} ${ex.left < 0 || ex.top < 0 || ex.right < 0 || ex.bottom < 0 || angle ? 'shade' : ''}`}
              style={{ left: -ex.left, top: -ex.top, width: W + ex.left + ex.right, height: H + ex.top + ex.bottom, borderWidth: 2 / view.s, ['--line' as string]: `${1 / view.s}px` }}
            />
          )}
          {level && (
            <svg className="level-line" width={W} height={H} style={{ overflow: 'visible' }}>
              <line x1={level[0].x} y1={level[0].y} x2={level[1].x} y2={level[1].y} strokeWidth={2 / view.s} />
            </svg>
          )}
          {painting && shape && shape.length > 1 && <ShapePreview kind={mask.tool} pts={shape} s={view.s} />}
          {expanding &&
            (['left', 'right', 'top', 'bottom'] as const).map((side) => {
              const k = 14 / view.s
              const pos: Record<string, React.CSSProperties> = {
                left: { left: -ex.left - k / 2, top: H / 2 - k / 2 },
                right: { left: W + ex.right - k / 2, top: H / 2 - k / 2, cursor: 'ew-resize' },
                top: { left: W / 2 - k / 2, top: -ex.top - k / 2 },
                bottom: { left: W / 2 - k / 2, top: H + ex.bottom - k / 2 },
              }
              return (
                <div
                  key={side}
                  className="expand-handle"
                  style={{ ...pos[side], width: k, height: k, borderWidth: 2 / view.s, borderRadius: 4 / view.s, cursor: side === 'left' || side === 'right' ? 'ew-resize' : 'ns-resize' }}
                  onPointerDown={startExpandDrag(side)}
                />
              )
            })}
          {showCompare && (
            <>
              <div
                className="compare-handle"
                style={{ left: split * W, width: 2 / view.s }}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  ;(stageRef.current as HTMLElement).setPointerCapture(e.pointerId)
                  drag.current = { kind: 'split', start: { x: 0, y: 0 }, last: { x: 0, y: 0 } }
                }}
              />
            </>
          )}
        </div>
      )}

      {showCompare && (
        <>
          <span className="compare-label" style={{ left: 12, top: 64 }}>BEFORE</span>
          <span className="compare-label" style={{ right: 12, top: 64 }}>AFTER</span>
        </>
      )}

      {painting && cursor && !space && (mask.tool === 'brush' || mask.tool === 'eraser') && (
        <div className="brush-cursor" style={{ left: cursor.x, top: cursor.y, width: mask.size * view.s, height: mask.size * view.s }} />
      )}
      {painting && cursor && !space && mask.tool !== 'brush' && mask.tool !== 'eraser' && (
        <div className="brush-cursor" style={{ left: cursor.x, top: cursor.y, width: 10, height: 10 }} />
      )}

      {showLive && liveJob && (
        <div className="live-badge">
          <Loader2 size={14} className="spin" />
          <span>
            {liveJob.status === 'queued' ? 'Queued' : liveJob.phase}
            {liveJob.steps > 0 && liveJob.phase === 'Generating' ? ` ${liveJob.step}/${liveJob.steps}` : ''}
            {liveJob.count > 1 ? ` · image ${liveJob.index + 1} of ${liveJob.count}` : ''}
          </span>
          <div className="bar">
            <i style={{ width: `${Math.round(liveJob.progress * 100)}%` }} />
          </div>
          <button className="btn sm ghost" onClick={() => api.cancel(liveJob.id)}>
            Cancel
          </button>
          {asset && (
            <button className="btn sm ghost icon" title="Stop following" onClick={() => set({ live: null })}>
              <X size={13} />
            </button>
          )}
        </div>
      )}

      {tool === 'layout' && (
        <div className="layout-switch">
          <button onClick={() => set({ layoutView: 'edit' })}>Layout</button>
          <button className="on">Result</button>
        </div>
      )}
      {!showLive && painting && <MaskToolbar />}
      {!showLive && !painting && asset && <ImageToolbar tool={tool} />}

      {!showLive && asset && !painting && (
        <div className="stage-info">
          {asset.prompt && <div className="p">{asset.prompt}</div>}
          <div className="meta">
            {asset.op} · {asset.width}×{asset.height}
            {asset.has_alpha ? ' · alpha' : ''}
            {asset.params?.model === 'moss' ? ` · MOSS ${asset.params.checkpoint === 'base' ? 'Base' : 'SFT'}` : ''}
            {asset.params?.crop_only ? ` · ${asset.params.angle ? `straightened ${asset.params.angle > 0 ? '+' : ''}${asset.params.angle}°` : 'cropped'}` : ''}
            {asset.params?.seed !== undefined && !asset.params.crop_only ? ` · seed ${asset.params.seed}` : ''}
            {asset.params?.crop_only ? '' : asset.params?.turbo ? ' · turbo' : asset.params?.steps ? ` · ${asset.params.steps} steps` : ''}
          </div>
        </div>
      )}

      {(src || showLive) && (
        <div className="zoom-ctl">
          <button className="btn sm ghost icon" onClick={() => zoomBy(1 / 1.25)} title="Zoom out">
            <Minus size={13} />
          </button>
          <span>{Math.round(view.s * 100)}%</span>
          <button className="btn sm ghost icon" onClick={() => zoomBy(1.25)} title="Zoom in">
            <Plus size={13} />
          </button>
          <button className="btn sm ghost icon" onClick={fit} title="Fit (F)">
            <Maximize size={13} />
          </button>
          <button className="btn sm ghost" onClick={actual} title="Actual size">
            1:1
          </button>
        </div>
      )}
    </div>
  )
}

function ShapePreview({ kind, pts, s }: { kind: string; pts: Pt[]; s: number }) {
  const a = pts[0]
  const b = pts[pts.length - 1]
  const style = { fill: 'rgba(95,212,192,0.35)', stroke: '#5fd4c0', strokeWidth: 2 / s }
  return (
    <svg style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }} width="1" height="1">
      {kind === 'rect' && <rect x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} {...style} />}
      {kind === 'ellipse' && <ellipse cx={(a.x + b.x) / 2} cy={(a.y + b.y) / 2} rx={Math.abs(b.x - a.x) / 2} ry={Math.abs(b.y - a.y) / 2} {...style} />}
      {kind === 'lasso' && <polygon points={pts.map((p) => `${p.x},${p.y}`).join(' ')} {...style} />}
    </svg>
  )
}

function MaskToolbar() {
  const mask = useStore((s) => s.mask)
  const patch = useStore((s) => s.patch)
  const tools = [
    { t: 'brush', icon: <Brush size={15} />, label: 'Brush (B)' },
    { t: 'eraser', icon: <Eraser size={15} />, label: 'Eraser (E)' },
    { t: 'rect', icon: <Square size={15} />, label: 'Rectangle (R)' },
    { t: 'ellipse', icon: <Circle size={15} />, label: 'Ellipse (O)' },
    { t: 'lasso', icon: <Lasso size={15} />, label: 'Lasso (L)' },
  ] as const
  return (
    <div className="stage-toolbar" onPointerDown={(e) => e.stopPropagation()}>
      {tools.map((x) => (
        <button key={x.t} className={`btn sm icon ${mask.tool === x.t ? 'on' : 'ghost'}`} title={x.label} onClick={() => patch('mask', { tool: x.t })}>
          {x.icon}
        </button>
      ))}
      <span className="divider" />
      <input type="range" min={4} max={400} value={mask.size} onChange={(e) => patch('mask', { size: Number(e.target.value) })} style={{ width: 110 }} title="Brush size ([ and ])" />
      <span style={{ font: '11px var(--mono)', color: 'var(--text-2)', width: 38 }}>{mask.size}px</span>
      <span className="divider" />
      <button className="btn sm icon ghost" title="Undo (⌘Z)" onClick={undo}>
        <Undo2 size={15} />
      </button>
      <button className="btn sm ghost" title="Invert mask" onClick={invertMask}>
        <Scan size={14} /> Invert
      </button>
      <button className="btn sm ghost" title="Clear mask" onClick={clearMask}>
        <RotateCcw size={14} /> Clear
      </button>
    </div>
  )
}

function ImageToolbar({ tool }: { tool: Tool }) {
  const activeModel = useStore((s) => s.activeModel)
  const viewing = useStore((s) => s.viewing)
  const a = useStore((s) => (viewing ? s.assetMap[viewing] : undefined))
  const compare = useStore((s) => s.compare)
  const set = useStore((s) => s.set)
  const useImage = useStore((s) => s.useImage)
  const upsertAsset = useStore((s) => s.upsertAsset)
  const removeAsset = useStore((s) => s.removeAsset)
  const toast = useStore((s) => s.toast)
  const region = useStore((s) => s.region)
  const expand = useStore((s) => s.expand)
  const adjust = useStore((s) => s.adjust)
  const resize = useStore((s) => s.resize)
  const workspace = useStore((s) => s.workspace)
  const setWorkspace = useStore((s) => s.setWorkspace)
  const newImage = useStore((s) => s.newImage)
  if (!a) return null
  const parent = a.parents[0]
  const target = tool === 'region' ? region.image : tool === 'expand' || tool === 'crop' ? expand.image : tool === 'adjust' ? adjust.image : tool === 'resize' ? resize.image : null
  const onThis: Partial<Record<Tool, [string, string]>> = {
    region: ['Paint on this', 'Paint on this image'],
    expand: ['Expand this', 'Expand this image'],
    crop: ['Crop this', 'Crop this image'],
    adjust: ['Adjust this', 'Adjust this image'],
    resize: ['Resize this', 'Resize this image'],
  }
  const tools: Tool[] = workspace === 'traditional' ? ['crop', 'adjust', 'resize'] : activeModel === 'qwen' ? ['edit', 'region', 'expand', 'cutout', 'remix'] : []
  return (
    <div className="stage-toolbar" onPointerDown={(e) => e.stopPropagation()}>
      <button className="btn sm ghost" title="Clear the canvas for a new image (⌘N)" onClick={newImage}>
        <ImagePlus size={14} /> New image
      </button>
      <span className="divider" />
      {onThis[tool] && target !== a.id && (
        <>
          <button className="btn sm on" onClick={() => useImage(tool, a.id)} title={onThis[tool]![1]}>
            <ImageUp size={14} /> {onThis[tool]![0]}
          </button>
          <span className="divider" />
        </>
      )}
      {tools.map((t) => (
        <button key={t} className="btn sm ghost" title={`Use in ${TOOL_NAMES[t]}`} onClick={() => useImage(t, a.id)}>
          {TOOL_ICONS[t](14)} {TOOL_NAMES[t]}
        </button>
      ))}
      {workspace !== 'traditional' && (
        <button className="btn sm ghost" title="Crop, adjust or resize this image with the traditional tools" onClick={() => (setWorkspace('traditional'), useImage('adjust', a.id))}>
          {TOOL_ICONS.adjust(14)} Adjust
        </button>
      )}
      <span className="divider" />
      {parent && (
        <button className={`btn sm icon ${compare ? 'on' : 'ghost'}`} title="Compare with the input (C)" onClick={() => set({ compare: !compare })}>
          <Columns2 size={15} />
        </button>
      )}
      {a.op !== 'import' && a.op !== 'transform' && (
        <button className="btn sm icon ghost" title="Reuse these settings" onClick={() => reuseSettings(a)}>
          <History size={15} />
        </button>
      )}
      <button
        className="btn sm icon ghost"
        title={a.favorite ? 'Unstar (S)' : 'Star (S)'}
        onClick={async () => upsertAsset(await api.patch(a.id, { favorite: !a.favorite }))}
      >
        <Star size={15} fill={a.favorite ? 'var(--warm)' : 'none'} color={a.favorite ? 'var(--warm)' : 'currentColor'} />
      </button>
      <button
        className="btn sm icon ghost"
        title="Copy image"
        onClick={async () => {
          try {
            await native.copyImage(a)
            toast('Copied to clipboard', 'success')
          } catch (e: any) {
            toast(e.message, 'error')
          }
        }}
      >
        <Copy size={15} />
      </button>
      <button className="btn sm icon ghost" title="Save as…" onClick={() => native.saveAs(a)}>
        <Download size={15} />
      </button>
      <button className="btn sm icon ghost" title="Show in Finder" onClick={() => api.reveal(a.id)}>
        <FolderOpen size={15} />
      </button>
      <button
        className="btn sm icon ghost danger"
        title="Move to Trash"
        onClick={async () => {
          if (!confirm('Move this image to the Trash?')) return
          await api.trash(a.id)
          removeAsset(a.id)
        }}
      >
        <Trash2 size={15} />
      </button>
    </div>
  )
}

function EmptyStage() {
  const tool = useStore((s) => s.tool)
  return (
    <div className="empty-stage">
      <MozaicMark size={54} />
      <h3>{tool === 'create' ? 'Describe an image to begin' : 'Drop an image here'}</h3>
      <div style={{ maxWidth: 380 }}>
        {tool === 'create'
          ? 'Write a prompt on the right and press ⌘↵. Drop or paste images anywhere to edit them.'
          : 'Drop or paste an image, or pick one from the library, to start editing.'}
      </div>
    </div>
  )
}

export function MozaicMark({ size = 22 }: { size?: number }) {
  return <img src="/mark.png" width={size} height={size} alt="" draggable={false} style={{ display: 'block' }} />
}
