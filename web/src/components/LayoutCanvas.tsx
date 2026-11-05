import { useEffect, useRef, useState } from 'react'
import { useStore, type LayoutItem } from '../store'
import { mossSize, newLayoutItem } from './MossPanels'

type Drag =
  | { kind: 'new'; x: number; y: number; id: string }
  | { kind: 'move'; id: string; x: number; y: number; box: LayoutItem['box'] }
  | { kind: 'resize'; id: string; x: number; y: number; box: LayoutItem['box'] }

const clamp = (v: number) => Math.min(1, Math.max(0, v))

/** The Layout tool's canvas: draw, move and resize boxes over a frame of the output's aspect ratio. */
export function LayoutCanvas() {
  const layout = useStore((s) => s.layout)
  const moss = useStore((s) => s.moss)
  const patch = useStore((s) => s.patch)
  const stageRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const [frame, setFrame] = useState({ w: 600, h: 600 })
  const [W, H] = mossSize(moss)

  useEffect(() => {
    const fit = () => {
      const el = stageRef.current
      if (!el) return
      const s = Math.min((el.clientWidth - 80) / W, (el.clientHeight - 80) / H)
      setFrame({ w: W * s, h: H * s })
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [W, H])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('textarea, input')) return
      const s = useStore.getState()
      if ((e.key === 'Backspace' || e.key === 'Delete') && s.layout.selected) {
        s.patch('layout', { items: s.layout.items.filter((x) => x.id !== s.layout.selected), selected: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const pos = (e: { clientX: number; clientY: number }) => {
    const r = frameRef.current!.getBoundingClientRect()
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) }
  }
  const items = () => useStore.getState().layout.items
  const setBox = (id: string, box: LayoutItem['box']) => patch('layout', { items: items().map((it) => (it.id === id ? { ...it, box } : it)) })

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const t = e.target as HTMLElement
    const p = pos(e)
    const boxEl = t.closest('[data-box]') as HTMLElement | null
    if (boxEl) {
      const id = boxEl.dataset.box!
      const it = items().find((x) => x.id === id)!
      patch('layout', { selected: id })
      drag.current = { kind: t.dataset.handle ? 'resize' : 'move', id, x: p.x, y: p.y, box: it.box }
      return
    }
    const it = newLayoutItem('object', [p.x, p.y, p.x, p.y])
    patch('layout', { items: [...items(), it], selected: it.id })
    drag.current = { kind: 'new', x: p.x, y: p.y, id: it.id }
  }

  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const p = pos(e)
    if (d.kind === 'new') {
      setBox(d.id, [Math.min(d.x, p.x), Math.min(d.y, p.y), Math.max(d.x, p.x), Math.max(d.y, p.y)])
    } else if (d.kind === 'move') {
      const [x0, y0, x1, y1] = d.box
      const dx = Math.min(1 - x1, Math.max(-x0, p.x - d.x))
      const dy = Math.min(1 - y1, Math.max(-y0, p.y - d.y))
      setBox(d.id, [x0 + dx, y0 + dy, x1 + dx, y1 + dy])
    } else {
      const [x0, y0] = d.box
      setBox(d.id, [x0, y0, Math.max(x0 + 0.02, p.x), Math.max(y0 + 0.02, p.y)])
    }
  }

  const up = () => {
    const d = drag.current
    drag.current = null
    if (d?.kind === 'new') {
      const it = items().find((x) => x.id === d.id)
      // A click without a drag makes no box.
      if (it && (it.box[2] - it.box[0] < 0.02 || it.box[3] - it.box[1] < 0.02)) {
        patch('layout', { items: items().filter((x) => x.id !== d.id), selected: null })
      }
    }
  }

  return (
    <div className="layout-stage" ref={stageRef}>
      <div className="layout-switch" onPointerDown={(e) => e.stopPropagation()}>
        <button className="on">Layout</button>
        <button onClick={() => useStore.getState().set({ layoutView: 'result' })} disabled={!useStore.getState().viewing}>
          Result
        </button>
      </div>
      <div
        className="layout-frame"
        ref={frameRef}
        style={{ width: frame.w, height: frame.h }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
      >
        {layout.summary && <div className="layout-summary">{layout.summary}</div>}
        {layout.items.map((it, i) => {
          const [x0, y0, x1, y1] = it.box
          return (
            <div
              key={it.id}
              data-box={it.id}
              className={`layout-box ${it.label} ${layout.selected === it.id ? 'sel' : ''}`}
              style={{ left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` }}
            >
              <span className="layout-badge">
                {i + 1} · {it.label}
              </span>
              <span className="layout-content">{it.label === 'text' ? `“${it.text}”` : it.caption || 'object'}</span>
              <span className="layout-handle" data-handle="1" />
            </div>
          )
        })}
        <span className="layout-size">
          {W} × {H}
        </span>
      </div>
    </div>
  )
}
