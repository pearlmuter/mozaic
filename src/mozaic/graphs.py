"""Builds ComfyUI API-format graphs for each Qwen Image 2.1 operation.

Only core ComfyUI nodes are used, so any ComfyUI with Qwen Image 2.1 support can run them.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field


def snap32(v: float) -> int:
    return max(32, int(round(v / 32)) * 32)


def size_for(aspect: float, megapixels: float) -> tuple[int, int]:
    """Width/height for an aspect ratio (w/h) at a pixel budget where 1 MP = 1024*1024."""
    area = megapixels * 1024 * 1024
    return snap32(math.sqrt(area * aspect)), snap32(math.sqrt(area / aspect))


@dataclass
class ModelSet:
    unet: str
    text_encoder: str
    vae: str
    weight_dtype: str = "default"
    cache_device: str = "auto"
    cache_dtype: str = "default"
    loras: list[dict] = field(default_factory=list)  # [{"name": str, "strength": float}]


@dataclass
class Sampling:
    seed: int
    steps: int = 30
    cfg: float = 1.0
    sampler: str = "euler"
    scheduler: str = "simple"
    denoise: float = 1.0


class Graph:
    def __init__(self) -> None:
        self.nodes: dict[str, dict] = {}

    def add(self, class_type: str, **inputs) -> str:
        nid = str(len(self.nodes) + 1)
        self.nodes[nid] = {"class_type": class_type, "inputs": inputs}
        return nid


def _models(g: Graph, m: ModelSet):
    unet = g.add("UNETLoader", unet_name=m.unet, weight_dtype=m.weight_dtype)
    model = [unet, 0]
    for lora in m.loras:
        if not lora.get("name"):
            continue
        lo = g.add("LoraLoaderModelOnly", model=model, lora_name=lora["name"],
                   strength_model=float(lora.get("strength", 1.0)))
        model = [lo, 0]
    cache = g.add("QwenImage21Cache", model=model, device=m.cache_device, dtype=m.cache_dtype)
    model = [cache, 0]
    clip = g.add("CLIPLoader", clip_name=m.text_encoder, type="qwen_image", device="default")
    vae = g.add("VAELoader", vae_name=m.vae)
    return model, [clip, 0], [vae, 0]


def _load(g: Graph, filename: str, has_alpha: bool):
    li = g.add("LoadImage", image=filename)
    if has_alpha:
        return [g.add("JoinImageWithAlpha", image=[li, 0], alpha=[li, 1]), 0]
    return [li, 0]


def _encode(g: Graph, clip, vae, prompt: str, negative: str, images: list, resolution: int):
    inputs = {"clip": clip, "prompt": prompt, "negative_prompt": negative, "resolution": resolution}
    if images:
        inputs["vae"] = vae
        for i, img in enumerate(images, start=1):
            inputs[f"images.image_{i}"] = img
    return g.add("TextEncodeQwenImage21", **inputs)


def _sample_and_save(g: Graph, model, te: str, latent, vae, s: Sampling, prefix: str):
    ks = g.add("KSampler", model=model, seed=s.seed, steps=s.steps, cfg=s.cfg, sampler_name=s.sampler,
               scheduler=s.scheduler, positive=[te, 0], negative=[te, 1], latent_image=latent, denoise=s.denoise)
    dec = g.add("VAEDecode", samples=[ks, 0], vae=vae)
    g.add("SaveImage", images=[dec, 0], filename_prefix=prefix)


def text_to_image(m: ModelSet, s: Sampling, prompt: str, negative: str, width: int, height: int,
                  prefix: str = "mozaic/gen") -> dict:
    g = Graph()
    model, clip, vae = _models(g, m)
    te = _encode(g, clip, vae, prompt, negative, [], 1024)
    lat = g.add("EmptyLatentImage", width=snap32(width), height=snap32(height), batch_size=1)
    _sample_and_save(g, model, te, [lat, 0], vae, s, prefix)
    return g.nodes


def edit(m: ModelSet, s: Sampling, prompt: str, negative: str, images: list[tuple[str, bool]],
         resolution: int = 1024, size: tuple[int, int] | None = None, prefix: str = "mozaic/edit") -> dict:
    """Reference-image edit. images[0] is the edit target; up to 10 more are references."""
    g = Graph()
    model, clip, vae = _models(g, m)
    loaded = [_load(g, name, alpha) for name, alpha in images]
    te = _encode(g, clip, vae, prompt, negative, loaded, resolution)
    if size:
        latent = [g.add("EmptyLatentImage", width=snap32(size[0]), height=snap32(size[1]), batch_size=1), 0]
    else:
        latent = [te, 2]
    _sample_and_save(g, model, te, latent, vae, s, prefix)
    return g.nodes


def repaint(m: ModelSet, s: Sampling, prompt: str, negative: str, image: tuple[str, bool], mask: str,
            references: list[tuple[str, bool]], width: int, height: int, prefix: str = "mozaic/repaint") -> dict:
    """Latent inpainting: only the masked area is re-noised; the image also conditions the model."""
    g = Graph()
    model, clip, vae = _models(g, m)
    src = _load(g, *image)
    scaled = [g.add("ImageScale", image=src, upscale_method="lanczos", width=snap32(width), height=snap32(height),
                    crop="disabled"), 0]
    refs = [scaled] + [_load(g, name, alpha) for name, alpha in references]
    te = _encode(g, clip, vae, prompt, negative, refs, 0)
    enc = g.add("VAEEncode", pixels=scaled, vae=vae)
    mk = g.add("LoadImageMask", image=mask, channel="red")
    noised = g.add("SetLatentNoiseMask", samples=[enc, 0], mask=[mk, 0])
    _sample_and_save(g, model, te, [noised, 0], vae, s, prefix)
    return g.nodes


def remix(m: ModelSet, s: Sampling, prompt: str, negative: str, image: tuple[str, bool], width: int, height: int,
          use_reference: bool = True, prefix: str = "mozaic/remix") -> dict:
    """Image-to-image at a chosen strength (denoise), optionally at a larger size for upscaling."""
    g = Graph()
    model, clip, vae = _models(g, m)
    src = _load(g, *image)
    scaled = [g.add("ImageScale", image=src, upscale_method="lanczos", width=snap32(width), height=snap32(height),
                    crop="disabled"), 0]
    te = _encode(g, clip, vae, prompt, negative, [src] if use_reference else [], 1024)
    enc = g.add("VAEEncode", pixels=scaled, vae=vae)
    _sample_and_save(g, model, te, [enc, 0], vae, s, prefix)
    return g.nodes

