// The region mask lives in one offscreen canvas at the image's natural size.
// Strokes are drawn in the accent colour; export turns them into white-on-black.

import { useStore } from '../store'

const MASK_COLOR = 'rgb(95, 212, 192)'

let canvas: HTMLCanvasElement | null = null
let owner: string | null = null
const undoStack: ImageData[] = []

export function maskCanvas(assetId: string, w: number, h: number): HTMLCanvasElement {
  if (!canvas || owner !== assetId || canvas.width !== w || canvas.height !== h) {
    canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    owner = assetId
    undoStack.length = 0
    setHas(false)
  }
  return canvas
}

function ctx() {
  return canvas!.getContext('2d', { willReadFrequently: true })!
}

function setHas(v: boolean) {
  const s = useStore.getState()
  s.patch('mask', { hasMask: v, version: s.mask.version + 1 })
}

export function snapshot() {
  if (!canvas) return
  undoStack.push(ctx().getImageData(0, 0, canvas.width, canvas.height))
  if (undoStack.length > 25) undoStack.shift()
}

export function undo() {
  const prev = undoStack.pop()
  if (!canvas || !prev) return
  ctx().putImageData(prev, 0, 0)
  setHas(!isEmpty())
}

export function clearMask() {
  if (!canvas) return
  snapshot()
  ctx().clearRect(0, 0, canvas.width, canvas.height)
  setHas(false)
}

export function invertMask() {
  if (!canvas) return
  snapshot()
  const c = ctx()
  c.globalCompositeOperation = 'xor'
  c.fillStyle = MASK_COLOR
  c.fillRect(0, 0, canvas.width, canvas.height)
  c.globalCompositeOperation = 'source-over'
  setHas(!isEmpty())
}

export function strokeLine(x0: number, y0: number, x1: number, y1: number, size: number, erase: boolean) {
  if (!canvas) return
  const c = ctx()
  c.globalCompositeOperation = erase ? 'destination-out' : 'source-over'
  c.strokeStyle = MASK_COLOR
  c.lineWidth = size
  c.lineCap = 'round'
  c.lineJoin = 'round'
  c.beginPath()
  c.moveTo(x0, y0)
  c.lineTo(x1 + 0.01, y1)
  c.stroke()
  c.globalCompositeOperation = 'source-over'
}

export function fillShape(kind: 'rect' | 'ellipse' | 'lasso', pts: { x: number; y: number }[], erase: boolean) {
  if (!canvas || pts.length < 2) return
  const c = ctx()
  c.globalCompositeOperation = erase ? 'destination-out' : 'source-over'
  c.fillStyle = MASK_COLOR
  c.beginPath()
  const a = pts[0]
  const b = pts[pts.length - 1]
  if (kind === 'rect') c.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
  else if (kind === 'ellipse') c.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2)
  else {
    c.moveTo(pts[0].x, pts[0].y)
    pts.slice(1).forEach((p) => c.lineTo(p.x, p.y))
    c.closePath()
  }
  c.fill()
  c.globalCompositeOperation = 'source-over'
}

export function strokeDone() {
  setHas(!isEmpty())
}

function isEmpty() {
  if (!canvas) return true
  const data = ctx().getImageData(0, 0, canvas.width, canvas.height).data
  for (let i = 3; i < data.length; i += 16) if (data[i] > 0) return false
  return true
}

export function hasMaskFor(assetId: string | null) {
  return !!canvas && owner === assetId && !isEmpty()
}

export async function exportMask(): Promise<Blob | null> {
  const s = useStore.getState()
  if (!canvas || owner !== s.region.image || isEmpty()) return null
  const out = document.createElement('canvas')
  out.width = canvas.width
  out.height = canvas.height
  const o = out.getContext('2d')!
  const tmp = document.createElement('canvas')
  tmp.width = canvas.width
  tmp.height = canvas.height
  const t = tmp.getContext('2d')!
  t.drawImage(canvas, 0, 0)
  t.globalCompositeOperation = 'source-in'
  t.fillStyle = '#fff'
  t.fillRect(0, 0, tmp.width, tmp.height)
  o.fillStyle = '#000'
  o.fillRect(0, 0, out.width, out.height)
  o.drawImage(tmp, 0, 0)
  return new Promise((res) => out.toBlob((b) => res(b), 'image/png'))
}
