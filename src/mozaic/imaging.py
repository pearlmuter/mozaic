"""Pixel helpers: masks, outlines, canvas expansion and compositing results back over originals."""

from __future__ import annotations

import io
import math

from PIL import Image, ImageChops, ImageFilter, ImageOps


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG", compress_level=1)
    return buf.getvalue()


def jpeg_preview(img: Image.Image, max_side: int = 768, quality: int = 82) -> bytes:
    im = img.copy()
    im.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    if im.mode == "RGBA":
        bg = checkerboard(im.size)
        bg.paste(im, mask=im.getchannel("A"))
        im = bg
    buf = io.BytesIO()
    im.convert("RGB").save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def checkerboard(size: tuple[int, int], cell: int = 16) -> Image.Image:
    w, h = size
    tile = Image.new("RGB", (cell * 2, cell * 2), (236, 236, 236))
    dark = Image.new("RGB", (cell, cell), (200, 200, 200))
    tile.paste(dark, (0, 0))
    tile.paste(dark, (cell, cell))
    out = Image.new("RGB", size)
    for y in range(0, h, cell * 2):
        for x in range(0, w, cell * 2):
            out.paste(tile, (x, y))
    return out


def to_mask(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Any mask image (white = selected, or opaque pixels if it has alpha) to a binary L mask at size."""
    if img.mode in ("RGBA", "LA") and img.getchannel("A").getextrema()[0] < 255:
        m = img.getchannel("A")
    else:
        m = img.convert("L")
    if m.size != size:
        m = m.resize(size, Image.Resampling.BILINEAR)
    return m.point(lambda v: 255 if v >= 128 else 0)


def grow(mask: Image.Image, px: int) -> Image.Image:
    if px <= 0:
        return mask
    blurred = mask.filter(ImageFilter.GaussianBlur(px / 2))
    return blurred.point(lambda v: 255 if v > 8 else 0)


def shrink(mask: Image.Image, px: int) -> Image.Image:
    if px <= 0:
        return mask
    return ImageOps.invert(grow(ImageOps.invert(mask), px))


def feather(mask: Image.Image, px: int) -> Image.Image:
    return mask.filter(ImageFilter.GaussianBlur(px / 2)) if px > 0 else mask


def mask_bbox(mask: Image.Image):
    return mask.getbbox()


def draw_outline(img: Image.Image, mask: Image.Image, color=(255, 0, 0), width: int = 0) -> Image.Image:
    """Draws a marker-style outline around the mask, the way you'd circle something on a print."""
    width = width or max(4, round(min(img.size) / 160))
    outer = grow(mask, width)
    ring = ImageChops.subtract(outer, mask)
    out = img.convert("RGBA") if img.mode == "RGBA" else img.convert("RGB")
    layer = Image.new(out.mode, out.size, color + ((255,) if out.mode == "RGBA" else ()))
    out.paste(layer, mask=ring)
    return out


def mask_reference(mask: Image.Image) -> Image.Image:
    """Black/white mask image passed to the model as a reference."""
    return Image.merge("RGB", (mask, mask, mask))


def pad(img: Image.Image, left: int, top: int, right: int, bottom: int,
        fill: str = "white") -> tuple[Image.Image, Image.Image]:
    """Expands the canvas. Returns the padded image and a mask of the NEW area (white)."""
    w, h = img.size
    nw, nh = w + left + right, h + top + bottom
    if fill == "transparent":
        canvas = Image.new("RGBA", (nw, nh), (0, 0, 0, 0))
        canvas.paste(img.convert("RGBA"), (left, top))
    else:
        mode = "RGBA" if img.mode == "RGBA" else "RGB"
        if fill == "blur":
            canvas = img.convert(mode).resize((nw, nh), Image.Resampling.BILINEAR).filter(ImageFilter.GaussianBlur(40))
        else:
            color = {"white": (255, 255, 255), "gray": (128, 128, 128), "black": (0, 0, 0)}.get(fill, (255, 255, 255))
            canvas = Image.new(mode, (nw, nh), color + ((255,) if mode == "RGBA" else ()))
        canvas.paste(img.convert(mode), (left, top))
    new_area = Image.new("L", (nw, nh), 255)
    new_area.paste(0, (left, top, left + w, top + h))
    return canvas, new_area


def _unrotate(w: int, h: int, left: int, top: int, angle: float) -> tuple[float, float, float, float, float, float]:
    """Affine coefficients mapping a framed output pixel back into the source image.

    The source is turned `angle` degrees clockwise (as on screen) about its centre, then framed: a positive
    side adds that many pixels of canvas, a negative one crops them away."""
    c, s = math.cos(math.radians(angle)), math.sin(math.radians(angle))
    cx, cy = w / 2, h / 2
    return (c, s, cx - c * (left + cx) - s * (top + cy), -s, c, cy + s * (left + cx) - c * (top + cy))


def frame_covered(w: int, h: int, left: int, top: int, right: int, bottom: int, angle: float = 0.0) -> bool:
    """True when the photo fills the whole frame, so there is nothing new to generate."""
    a, b, c, d, e, f = _unrotate(w, h, left, top, angle)
    for x in (0, w + left + right):
        for y in (0, h + top + bottom):
            qx, qy = a * x + b * y + c, d * x + e * y + f
            if not (-0.5 <= qx <= w + 0.5 and -0.5 <= qy <= h + 0.5):
                return False
    return True


def reframe(img: Image.Image, left: int, top: int, right: int, bottom: int, angle: float = 0.0,
            fill: str = "white") -> tuple[Image.Image, Image.Image]:
    """Straightens and crops or expands in one step. Returns the framed image and a mask of the area the
    photo does not cover (white), which is what the model fills."""
    w, h = img.size
    if not angle:
        cl, ct, cr, cb = (max(0, -v) for v in (left, top, right, bottom))
        img = img.crop((cl, ct, w - cr, h - cb))
        return pad(img, max(0, left), max(0, top), max(0, right), max(0, bottom), fill)
    nw, nh = w + left + right, h + top + bottom
    coeffs = _unrotate(w, h, left, top, angle)
    mode = "RGBA" if img.mode == "RGBA" else "RGB"
    turned = img.convert(mode).transform((nw, nh), Image.Transform.AFFINE, coeffs, Image.Resampling.BICUBIC)
    covered = Image.new("L", (w, h), 255).transform((nw, nh), Image.Transform.AFFINE, coeffs, Image.Resampling.BILINEAR)
    if fill == "transparent":
        canvas = Image.new("RGBA", (nw, nh), (0, 0, 0, 0))
        turned = turned.convert("RGBA")
    elif fill == "blur":
        canvas = img.convert(mode).resize((nw, nh), Image.Resampling.BILINEAR).filter(ImageFilter.GaussianBlur(40))
    else:
        color = {"white": (255, 255, 255), "gray": (128, 128, 128), "black": (0, 0, 0)}.get(fill, (255, 255, 255))
        canvas = Image.new(mode, (nw, nh), color + ((255,) if mode == "RGBA" else ()))
    canvas.paste(turned, (0, 0), covered)
    return canvas, ImageOps.invert(covered).point(lambda v: 255 if v > 8 else 0)


def composite(original: Image.Image, result: Image.Image, mask: Image.Image, feather_px: int = 0) -> Image.Image:
    """Keeps `original` outside `mask` and takes `result` inside it, with a soft edge."""
    size = original.size
    if result.size != size:
        result = result.resize(size, Image.Resampling.LANCZOS)
    mode = "RGBA" if "A" in original.mode or "A" in result.mode else "RGB"
    base, top = original.convert(mode), result.convert(mode)
    m = feather(mask.convert("L").resize(size), feather_px)
    return Image.composite(top, base, m)

