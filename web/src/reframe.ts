// Frame geometry for Expand, matching imaging.reframe on the server: the photo turns `angle` degrees clockwise
// about its centre, then a positive side grows the canvas by that many pixels and a negative one crops it.

export type Sides = { left: number; top: number; right: number; bottom: number }

/** True when the photo fills the whole frame, so the result is a plain crop with nothing to generate. */
export function covered(w: number, h: number, f: Sides, angle: number): boolean {
  const c = Math.cos((angle * Math.PI) / 180)
  const s = Math.sin((angle * Math.PI) / 180)
  const fw = w + f.left + f.right
  const fh = h + f.top + f.bottom
  for (const x of [0, fw])
    for (const y of [0, fh]) {
      const px = x - f.left - w / 2
      const py = y - f.top - h / 2
      const qx = c * px + s * py + w / 2
      const qy = -s * px + c * py + h / 2
      if (qx < -0.5 || qx > w + 0.5 || qy < -0.5 || qy > h + 0.5) return false
    }
  return true
}

/** The largest centred crop of aspect `ratio` (width / height) that the turned photo still fills. */
export function fitCrop(w: number, h: number, angle: number, ratio: number): Sides {
  const t = Math.abs((angle * Math.PI) / 180)
  const c = Math.cos(t)
  const s = Math.sin(t)
  const halfH = Math.min(w / 2 / (ratio * c + s), h / 2 / (ratio * s + c))
  // A pixel of slack keeps rounding from leaving slivers of empty corner.
  const slack = angle ? 2 : 0
  const fw = Math.max(16, Math.min(w, Math.floor(2 * halfH * ratio) - slack))
  const fh = Math.max(16, Math.min(h, Math.floor(2 * halfH) - slack))
  const cx = w - fw
  const cy = h - fh
  return { left: -Math.floor(cx / 2), right: -Math.ceil(cx / 2), top: -Math.floor(cy / 2), bottom: -Math.ceil(cy / 2) }
}
