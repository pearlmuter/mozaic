import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, ImagePlus, X } from 'lucide-react'
import { api, thumbUrl } from '../api'
import { assetOf, useStore } from '../store'

export function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle" onClick={() => onChange(!on)}>
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <span className={`switch ${on ? 'on' : ''}`} />
    </label>
  )
}

export function Seg<T extends string | number>({ value, options, onChange, wrap }: { value: T; options: { v: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; wrap?: boolean }) {
  return (
    <div className={`seg ${wrap ? 'wrap' : ''}`}>
      {options.map((o) => (
        <button key={String(o.v)} className={o.v === value ? 'on' : ''} onClick={() => onChange(o.v)} title={o.title}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  return (
    <div className="field">
      <span className="label">
        {label} <span className="val">{format ? format(value) : value}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  )
}

export function Details({ title, children, open }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="details" open={open}>
      <summary>
        <ChevronRight size={14} className="chev" />
        {title}
      </summary>
      <div className="details-body">{children}</div>
    </details>
  )
}

export function PromptBox({ value, onChange, placeholder, refs }: { value: string; onChange: (v: string) => void; placeholder: string; refs?: string[] }) {
  const insert = (token: string) => onChange(value ? `${value.replace(/\s+$/, '')} ${token} ` : `${token} `)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const on = () => (ref.current?.focus(), ref.current?.select())
    window.addEventListener('mozaic:focus-prompt', on)
    return () => window.removeEventListener('mozaic:focus-prompt', on)
  }, [])
  return (
    <div className="prompt-box">
      <textarea ref={ref} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} spellCheck style={refs?.length ? undefined : { paddingBottom: 9 }} />
      {!!refs?.length && (
        <div className="prompt-tools">
          {refs.map((r) => (
            <button key={r} className="chip" title={`Insert ${r}`} onClick={() => insert(r)}>
              {r}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function ImageSlot({
  id,
  onSet,
  onClear,
  tag,
  target,
  big,
  label = 'Add image',
}: {
  id: string | null | undefined
  onSet: (id: string) => void
  onClear?: () => void
  tag?: string
  target?: boolean
  big?: boolean
  label?: string
}) {
  const [over, setOver] = useState(false)
  const set = useStore((s) => s.set)
  const toast = useStore((s) => s.toast)
  const a = assetOf(id)

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setOver(false)
    const aid = e.dataTransfer.getData('application/x-mozaic-asset')
    if (aid) return onSet(aid)
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
    if (files.length) {
      try {
        const [up] = await api.upload(files.slice(0, 1))
        useStore.getState().upsertAsset(up)
        onSet(up.id)
      } catch (err: any) {
        toast(err.message, 'error')
      }
    }
  }

  return (
    <div
      className={`slot ${big ? 'big' : ''} ${a ? 'filled' : ''} ${over ? 'drop' : ''} ${a?.has_alpha ? 'checker' : ''}`}
      onDragOver={(e) => (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      onClick={() => set({ pickerFor: { title: label, onPick: onSet } })}
      title={a ? `${a.width}×${a.height} — click to replace` : 'Click to choose, or drop an image'}
    >
      {a ? (
        <img src={thumbUrl(a.id)} alt="" draggable={false} />
      ) : (
        <div className="slot-empty">
          <ImagePlus size={big ? 22 : 16} />
          {big && <span>{label}<br />click or drop</span>}
        </div>
      )}
      {tag && <span className={`tag ${target ? 'target' : ''}`}>{tag}</span>}
      {a && onClear && (
        <button className="x" onClick={(e) => (e.stopPropagation(), onClear())} title="Remove">
          <X size={12} />
        </button>
      )}
    </div>
  )
}
