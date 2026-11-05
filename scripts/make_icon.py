"""Renders the app icon from macos/icon-source.png into an .iconset folder (iconutil turns it into .icns).

`make_icon.py --mark web/public/mark.png` instead writes the in-app logo: the same tile without the icon
margin and shadow, used by the top bar, setup screen, empty canvas and the native splash.

The source is the mosaic teapot made in Mozaic itself; it is cropped square around the teapot and set in the
standard macOS icon tile (an 824 px rounded square on a 1024 px canvas, with a soft drop shadow)."""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SOURCE = Path(__file__).resolve().parents[1] / "macos" / "icon-source.png"
CROP = (20, 27, 490, 497)  # square around the teapot in the 512 px source


def render(size: int, photo: Image.Image) -> Image.Image:
    s = 4  # supersample
    n = size * s
    pad, body = n * 100 / 1024, n * 824 / 1024
    tile = Image.new("L", (n, n), 0)
    ImageDraw.Draw(tile).rounded_rectangle([pad, pad, pad + body, pad + body], radius=n * 185 / 1024, fill=255)
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    shadow = Image.new("RGBA", (n, n), (0, 0, 0, 90))
    img.paste(shadow, (0, round(n * 10 / 1024)), tile.filter(ImageFilter.GaussianBlur(n * 14 / 1024)))
    face = photo.resize((round(body), round(body)), Image.Resampling.LANCZOS)
    layer = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    layer.paste(face, (round(pad), round(pad)))
    img.paste(layer, (0, 0), tile)
    return img.resize((size, size), Image.Resampling.LANCZOS)


def mark(size: int, photo: Image.Image) -> Image.Image:
    n = size * 4
    tile = Image.new("L", (n, n), 0)
    ImageDraw.Draw(tile).rounded_rectangle([0, 0, n - 1, n - 1], radius=n * 185 / 824, fill=255)
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    img.paste(photo.resize((n, n), Image.Resampling.LANCZOS), (0, 0), tile)
    return img.resize((size, size), Image.Resampling.LANCZOS)


photo = Image.open(SOURCE).convert("RGB").crop(CROP)
if sys.argv[1] == "--mark":
    mark(256, photo).save(sys.argv[2], optimize=True)
    sys.exit()
out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
for base in (16, 32, 128, 256, 512):
    render(base, photo).save(out / f"icon_{base}x{base}.png")
    render(base * 2, photo).save(out / f"icon_{base}x{base}@2x.png")
