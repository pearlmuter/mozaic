"""MCP server: lets an AI agent drive Mozaic.

Served two ways from the same tool definitions:
- streamable HTTP at http://127.0.0.1:47811/mcp while Mozaic runs, and
- stdio via `mozaic mcp`, which starts a headless Mozaic in the background when none is running.
Every tool goes through Mozaic's HTTP API, so the UI shows the agent's work live.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import httpx
from mcp.server.mcpserver import Context, Image, MCPServer

from . import config

GUIDE = """\
# Mozaic guide for agents

Mozaic runs two local image models; only one is loaded at a time and Mozaic switches automatically
(switching costs a model load, so batch work per model):
- **qwen** - Qwen Image 2.1 on ComfyUI: text to image plus every editing tool.
- **moss** - MOSS-Image on MLX: text to image and layout-to-image only (generate_image with
  model="moss", generate_layout). Strong long text in English and Chinese, real negative prompts
  (CFG 3), SFT (polished) or Base (rawer, less curated) checkpoints, Turbo mode (~6x faster).
  No editing, region, expand, cut-out or remix: those tools always use Qwen.

Images live in Mozaic's library and are referred to by a 12-character id. Any tool argument that takes an image also accepts an absolute
file path, an http(s) URL or a data: URI; it is imported into the library first.

## What the model does well
- Text to image up to native 2K. Official sizes: 1:1 2048x2048, 4:3 2400x1792, 3:2 2528x1696,
  16:9 2752x1536 and the portrait flips. megapixels=1 is fast (1024x1024 area), 4 is native 2K.
- Text rendering: put the exact words in double quotes, e.g. a sign that reads "OPEN LATE".
- Transparent PNGs straight from text (transparent=true wraps the prompt in the RGBA template).
- Instruction editing with up to 10 images. The first image is the one edited, the others are
  references. Refer to them as <image1>, <image2>, ... in the prompt.
  Example: "Put the jacket from <image2> on the person in <image1>, keep the face and pose."
- Identity preservation for people and products across edits and multi-reference compositions.
- Local edits limited to a mask (edit_region), canvas expansion, cropping and straightening (expand_image), background
  removal / subject extraction with real alpha (remove_background), variations and upscaling
  (remix_image).

## Prompting tips
- Describe subject, setting, composition, lighting, style/medium, and camera for photos.
- Edit prompts should say what changes and what must stay the same.
- cfg 1 is the official setting; negative prompts only matter when cfg > 1.
- 30 steps is a good default; 40-50 is the official quality setting; fewer is faster.

## MOSS-Image tips
- Sizes from 256x256 to about 1456x1456 (multiples of 16); trained around 1 MP.
- Official settings: 50 steps, CFG 3, shift 5. turbo=true uses a distilled 15-pass sampler (SFT only).
- Long, detailed prompts work well (up to 4K tokens); words to render go in double quotes.
- Layouts: give a summary of the whole image and items with boxes; text items render their exact text.

## Timing
On this Mac a 1 MP Qwen image takes a few minutes; MOSS takes about 2-3 minutes with turbo and
12-15 minutes at the official 50 steps. The first job after a model switch also loads the model.
Tools wait for results by default (up to `timeout` seconds). If a job is still running when the
wait ends, you get its job_id: call get_job with wait_seconds to keep waiting.

## Queueing many jobs (batches, overnight work)
Jobs run one at a time in a shared queue with the person's own jobs. To queue several, call the tools
with wait=false: each returns a job_id and its place in the queue right away. Then call wait_for_jobs:
it returns as soon as the next job finishes, with its images, so you can review each result and queue
fixes while the rest keep running (all=true waits for every job instead). list_jobs shows the queue,
and cancel_job removes one job from it. Crops and straightens (expand_image with negative sides) are
instant and skip the queue.
"""

INSTRUCTIONS = (
    "Mozaic creates and edits images with two local models: Qwen Image 2.1 (generation and all editing) and "
    "MOSS-Image (generation and layout-to-image, strong text rendering). Read the mozaic://guide resource "
    "for prompting tips. Images are referenced by library id, absolute path, URL or data URI. Generation "
    "takes about a minute per image; tools wait for the result and return file paths plus small previews."
)


def base_url() -> str:
    return os.environ.get("MOZAIC_URL", f"http://127.0.0.1:{config.DEFAULT_PORT}").rstrip("/")


class Api:
    def __init__(self) -> None:
        self.client = httpx.AsyncClient(base_url=base_url(), timeout=httpx.Timeout(120.0, connect=3.0))
        self.on_submit: Any = None  # called with (ctx, job) after each submission

    async def call(self, method: str, path: str, **kw) -> Any:
        r = await self.client.request(method, path, **kw)
        if r.status_code >= 400:
            try:
                detail = r.json().get("detail", r.text)
            except Exception:
                detail = r.text
            raise RuntimeError(f"Mozaic: {detail}")
        return r.json()

    async def image_id(self, ref: str) -> str:
        return (await self.call("POST", "/api/assets/import", json={"source": ref}))["id"]

    async def run(self, ctx: Context | None, op: str, params: dict, wait: bool, timeout: float,
                  return_preview: bool) -> list:
        params = {k: v for k, v in params.items() if v is not None}
        job = await self.call("POST", "/api/jobs", json={"op": op, "params": params, "source": "agent"})
        if self.on_submit:
            self.on_submit(ctx, job)
        if not wait:
            queued = [j for j in reversed(await self.call("GET", "/api/jobs")) if j["status"] in ("queued", "running")]
            ahead = next((i for i, j in enumerate(queued) if j["id"] == job["id"]), 0)
            return [json.dumps({"job_id": job["id"], "status": job["status"], "jobs_ahead": ahead,
                                "note": "Call wait_for_jobs to be told when it finishes."})]
        return await self.finish(ctx, job["id"], timeout, return_preview)

    async def finish(self, ctx: Context | None, job_id: str, timeout: float, return_preview: bool) -> list:
        deadline = time.time() + timeout
        job = await self.call("GET", f"/api/jobs/{job_id}")
        while job["status"] in ("queued", "running") and time.time() < deadline:
            job = await self.call("GET", f"/api/jobs/{job_id}/wait",
                                  params={"timeout": min(15, max(1, deadline - time.time()))})
            if ctx is not None:
                try:
                    await ctx.report_progress(job["progress"], 1.0, job.get("phase"))
                except Exception:
                    pass
        return await self.describe_job(job, return_preview)

    async def describe_job(self, job: dict, return_preview: bool) -> list:
        summary: dict[str, Any] = {"job_id": job["id"], "operation": job["op"], "status": job["status"]}
        if job["status"] in ("queued", "running"):
            summary.update(progress=job["progress"], phase=job["phase"],
                           note="Still running. Call get_job with wait_seconds to keep waiting.")
        if job.get("error"):
            summary["error"] = job["error"]
        content: list = []
        images = []
        for aid in job.get("outputs", []):
            a = await self.call("GET", f"/api/assets/{aid}")
            images.append(asset_summary(a))
            if return_preview:
                content.append(await self.preview(aid))
        if images:
            summary["images"] = images
        if job.get("started_at") and job.get("finished_at"):
            summary["seconds"] = round(job["finished_at"] - job["started_at"], 1)
        return [json.dumps(summary, indent=2), *content]

    async def preview(self, aid: str) -> Image:
        r = await self.client.get(f"/api/assets/{aid}/thumb")
        r.raise_for_status()
        return Image(data=r.content, format="webp")


def asset_summary(a: dict) -> dict:
    return {
        "id": a["id"], "path": a["path"], "width": a["width"], "height": a["height"],
        "transparent": a["has_alpha"], "operation": a["op"], "prompt": a.get("prompt") or "",
        "seed": (a.get("params") or {}).get("seed"), "favorite": a["favorite"],
        "created": time.strftime("%Y-%m-%d %H:%M", time.localtime(a["created_at"])),
    }


def job_line(j: dict) -> dict:
    """A compact queue entry for list_jobs and wait_for_jobs."""
    p = j.get("params") or {}
    out = {"job_id": j["id"], "operation": j["op"], "status": j["status"], "source": j.get("source", "app")}
    if p.get("prompt"):
        out["prompt"] = p["prompt"][:160]
    if p.get("model") == "moss":
        out["model"] = "moss"
    if j["status"] == "running":
        out.update(progress=j["progress"], phase=j["phase"])
    if j.get("error"):
        out["error"] = j["error"]
    if j.get("outputs"):
        out["images"] = j["outputs"]
    return out


def build_mcp(channel: bool = False) -> MCPServer:
    """channel: also push a Claude Code channel event when an agent's job finishes (stdio only)."""
    mcp = MCPServer("Mozaic", instructions=INSTRUCTIONS + (CHANNEL_NOTE if channel else ""), version="0.1.0")
    api = Api()

    if channel:
        watched: set[str] = set()

        async def announce(conn: Any, job_id: str) -> None:
            job = await api.call("GET", f"/api/jobs/{job_id}")
            while job["status"] in ("queued", "running"):
                job = await api.call("GET", f"/api/jobs/{job_id}/wait", params={"timeout": 15})
            p = job.get("params") or {}
            what = f'{job["op"]}' + (f': "{p["prompt"][:120]}"' if p.get("prompt") else "")
            if job["status"] == "done":
                text = f"Mozaic finished {what}. Images: {', '.join(job['outputs'])}. Call get_job to review them."
            else:
                text = f"Mozaic job {what} ended as {job['status']}" + (f": {job['error']}" if job.get("error") else ".")
            left = sum(1 for j in await api.call("GET", "/api/jobs") if j["status"] in ("queued", "running"))
            try:
                await conn.notify("notifications/claude/channel", {
                    "content": text, "meta": {"job_id": job["id"], "status": job["status"], "jobs_left": str(left)}})
            except Exception:
                pass  # the client went away or doesn't listen for channel events

        def on_submit(ctx: Context | None, job: dict) -> None:
            # The session's connection outlives the tool call, so events can be pushed while the agent is idle.
            conn = getattr(getattr(ctx, "session", None), "_connection", None) if ctx else None
            if conn is None or job["id"] in watched or job["status"] not in ("queued", "running"):
                return
            watched.add(job["id"])
            asyncio.get_running_loop().create_task(announce(conn.outbound, job["id"]))

        api.on_submit = on_submit

    async def ids(refs: list[str] | None) -> list[str]:
        return [await api.image_id(r) for r in (refs or [])]

    def sampling(seed, steps, cfg, negative_prompt, count, loras=None) -> dict:
        return {"seed": seed, "steps": steps, "cfg": cfg, "negative_prompt": negative_prompt, "count": count,
                "loras": loras}

    @mcp.resource("mozaic://guide", name="Qwen Image 2.1 guide", mime_type="text/markdown")
    def guide() -> str:
        return GUIDE

    @mcp.tool(structured_output=False)
    async def mozaic_status() -> list:
        """Engine state (ComfyUI), selected models, queued jobs and where the library lives."""
        status = await api.call("GET", "/api/status")
        try:
            status["models"] = await api.call("GET", "/api/models")
        except Exception as e:
            status["models"] = f"unavailable: {e}"
        return [json.dumps(status, indent=2)]

    @mcp.tool(structured_output=False)
    async def generate_image(
        prompt: str,
        model: str | None = None,
        aspect_ratio: str = "1:1",
        megapixels: float = 1.0,
        width: int | None = None,
        height: int | None = None,
        transparent: bool = False,
        count: int = 1,
        seed: int = -1,
        steps: int | None = None,
        cfg: float | None = None,
        negative_prompt: str = "",
        checkpoint: str | None = None,
        turbo: bool = False,
        shift: float | None = None,
        wait: bool = True,
        timeout: float = 1800,
        return_preview: bool = True,
        ctx: Context | None = None,
    ) -> list:
        """Create images from a text prompt.

        model: "qwen" (Qwen Image 2.1) or "moss" (MOSS-Image). Default: whichever is loaded in Mozaic.
        aspect_ratio: "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16" or any "W:H".
        megapixels: qwen 1 = ~1024x1024 (fast), 4 = native 2K; moss 0.25-2 (1 is its trained size).
            Ignored when width and height are set (moss needs multiples of 16).
        count: number of images, each with seed+i. seed -1 picks a random seed.
        Qwen only: transparent=true makes a PNG with a real alpha channel. cfg defaults to 1.
        MOSS only: checkpoint "sft" (polished) or "base" (rawer, less curated); turbo=true is ~6x faster
            (SFT only); cfg defaults to 3 and negative_prompt has a real effect; shift defaults to 5;
            steps default 50.
        Returns ids, file paths and previews of the new images.
        """
        params = {"prompt": prompt, "model": model, "aspect": aspect_ratio, "megapixels": megapixels,
                  "width": width, "height": height, "transparent": transparent, "checkpoint": checkpoint,
                  "turbo": turbo, "shift": shift, **sampling(seed, steps, cfg, negative_prompt, count)}
        return await api.run(ctx, "generate", params, wait, timeout, return_preview)

    @mcp.tool(structured_output=False)
    async def generate_layout(
        summary: str,
        items: list[dict],
        width: int = 1024,
        height: int = 1024,
        negative_prompt: str = "",
        checkpoint: str | None = None,
        turbo: bool = False,
        count: int = 1,
        seed: int = -1,
        steps: int | None = None,
        cfg: float | None = None,
        wait: bool = True,
        timeout: float = 1800,
        return_preview: bool = True,
        ctx: Context | None = None,
    ) -> list:
        """Layout-to-image with MOSS-Image: place text and objects in boxes and let the model compose the rest.

        summary: the whole image - scene, mood, style, colours.
        items: list of {"label": "text" | "object", "caption": how it looks, "text": exact words (text items),
               "box": [x0, y0, x1, y1]} with box in pixels from the TOP-LEFT of a width x height canvas.
        width/height: 256-1456, multiples of 16.
        Example item: {"label": "text", "text": "OPEN LATE", "caption": "red neon script", "box": [200, 80, 820, 260]}
        """
        layout_items = []
        for it in items:
            x0, y0, x1, y1 = it["box"]
            entry = {"label": it.get("label", "object"),
                     "caption": it.get("caption") or it.get("text") or "an object",
                     "bbox": [round(y0 - height / 2), round(x0 - width / 2), round(y1 - height / 2), round(x1 - width / 2)]}
            if it.get("text"):
                entry["text"] = it["text"]
            layout_items.append(entry)
        layout = {"summary": {"caption": summary}, "items": layout_items,
                  "bbox_format": "yxyx", "bbox_coord_space": "abs_centralized"}
        params = {"model": "moss", "layout": layout, "width": width, "height": height,
                  "negative_prompt": negative_prompt, "checkpoint": checkpoint, "turbo": turbo, "count": count,
                  "seed": seed, "steps": steps, "cfg": cfg}
        return await api.run(ctx, "generate", params, wait, timeout, return_preview)

    @mcp.tool(structured_output=False)
    async def edit_image(
        prompt: str,
        images: list[str],
        resolution: int | None = None,
        width: int | None = None,
        height: int | None = None,
        transparent: bool = False,
        count: int = 1,
        seed: int = -1,
        steps: int | None = None,
        cfg: float | None = None,
        negative_prompt: str = "",
        wait: bool = True,
        timeout: float = 900,
        return_preview: bool = True,
        ctx: Context | None = None,
    ) -> list:
        """Edit an image with an instruction, optionally using up to 9 more reference images.

        images: 1-10 image refs (library id, absolute path, URL or data URI). images[0] is the image being
        edited; the rest are references. Name them in the prompt as <image1>, <image2>, ...
        Example: "Replace the sofa in <image1> with the chair from <image2>; keep the room and lighting."
        resolution: pixel budget for the output's side (e.g. 1024, 2048). Default keeps the input size.
        width/height: force an output canvas size (keep it close to the input's aspect or the edit can drift).
        transparent: ask for a PNG with a transparent background.
        """
        params = {"prompt": prompt, "images": await ids(images), "resolution": resolution, "width": width,
                  "height": height, "transparent": transparent,
                  **sampling(seed, steps, cfg, negative_prompt, count)}
        return await api.run(ctx, "edit", params, wait, timeout, return_preview)

    @mcp.tool(structured_output=False)
    async def edit_region(
        image: str,
        mask: str,
        prompt: str,
        method: str = "outline",
        references: list[str] | None = None,
        protect: bool = True,
        grow: int = 8,
        feather: int = 12,
        strength: float = 1.0,
        count: int = 1,
        seed: int = -1,
        steps: int | None = None,
        wait: bool = True,
        timeout: float = 900,
        return_preview: bool = True,
        ctx: Context | None = None,
    ) -> list:
        """Change only part of an image (inpainting).

        mask: image ref where WHITE (or opaque, if it has transparency) marks the area to change.
        method: "outline" draws a red marker outline around the area for the model (most natural),
                "mask" passes the mask as a second image, "repaint" re-noises only the masked latent
                (use `strength` 0-1 to control how much changes).
        references: extra images the edit can draw from. With "outline"/"repaint" they are <image2>...,
                    with "mask" they are <image3>...
        protect: paste the result back only inside the (grown, feathered) mask so the rest stays pixel-exact.
        """
        params = {"image": await api.image_id(image), "mask": await api.image_id(mask), "prompt": prompt,
                  "method": method, "references": await ids(references), "protect": protect, "grow": grow,
                  "feather": feather, "strength": strength, "seed": seed, "steps": steps, "count": count}
        return await api.run(ctx, "region", params, wait, timeout, return_preview)

    @mcp.tool(structured_output=False)
    async def expand_image(
        image: str,
        left: int = 0,
        top: int = 0,
        right: int = 0,
        bottom: int = 0,
        angle: float = 0,
        prompt: str = "",
        fill: str = "blur",
        protect: bool = True,
        count: int = 1,
        seed: int = -1,
        steps: int | None = None,
        wait: bool = True,
        timeout: float = 900,
        return_preview: bool = True,
        ctx: Context | None = None,
    ) -> list:
        """Outpaint, crop or straighten: grow the canvas by the given pixels per side and let the model fill the new
        area. Negative sides crop instead, and angle (degrees, clockwise, -45 to 45) straightens the image. When the
        image still fills the whole frame (a plain crop or straighten-and-crop) no model runs and it is instant.

        prompt: optional; describe only what should appear in the new area. Leave it empty to simply continue
                the scene, which gives the most seamless result.
        fill: how the new area starts out: "blur" (stretched, blurred copy; best for continuing the scene),
              "white", "gray", "black" or "transparent".
        protect: keep the original pixels exactly; only the new border is generated.
        """
        params = {"image": await api.image_id(image), "left": left, "top": top, "right": right, "bottom": bottom,
                  "angle": angle, "prompt": prompt, "fill": fill, "protect": protect, "seed": seed, "steps": steps, "count": count}
        return await api.run(ctx, "expand", params, wait, timeout, return_preview)

    @mcp.tool(structured_output=False)
    async def remove_background(
        image: str,
        subject: str = "",
        count: int = 1,
        seed: int = -1,
        steps: int | None = None,
        wait: bool = True,
        timeout: float = 900,
        return_preview: bool = True,
        ctx: Context | None = None,
    ) -> list:
        """Cut out the subject onto a transparent background (PNG with alpha).

        subject: optionally name what to keep (e.g. "red car", "woman on the left"); otherwise the main
        subject is kept and the background removed.
        """
        params = {"image": await api.image_id(image), "subject": subject, "seed": seed, "steps": steps,
                  "count": count}
        return await api.run(ctx, "cutout", params, wait, timeout, return_preview)

    @mcp.tool(structured_output=False)
    async def remix_image(
        image: str,
        prompt: str = "",
        strength: float = 0.45,
        scale: float = 1.0,
        use_reference: bool = False,
        count: int = 1,
        seed: int = -1,
        steps: int | None = None,
        wait: bool = True,
        timeout: float = 900,
        return_preview: bool = True,
        ctx: Context | None = None,
    ) -> list:
        """Image-to-image: variations, restyling or upscaling.

        strength: 0-1, how much may change (0.2-0.35 = subtle refine/upscale, 0.5 = variation, 0.8+ = loose).
        scale: output size relative to the input (e.g. 2 to upscale), capped at about 2048x2048.
        use_reference: also show the model the original image; results then stay very close to it (good for
                       clean upscales, not for variations). To restyle or change content, use edit_image instead.
        """
        params = {"image": await api.image_id(image), "prompt": prompt, "strength": strength, "scale": scale,
                  "use_reference": use_reference, "seed": seed, "steps": steps, "count": count}
        return await api.run(ctx, "remix", params, wait, timeout, return_preview)

    @mcp.tool(structured_output=False)
    async def get_job(job_id: str, wait_seconds: float = 0, return_preview: bool = True,
                      ctx: Context | None = None) -> list:
        """Status of a job; with wait_seconds > 0, waits that long for it to finish and returns its images."""
        if wait_seconds > 0:
            return await api.finish(ctx, job_id, wait_seconds, return_preview)
        return await api.describe_job(await api.call("GET", f"/api/jobs/{job_id}"), return_preview)

    @mcp.tool(structured_output=False)
    async def list_jobs(include_finished: int = 10) -> list:
        """The job queue: the running job, everything waiting in order, and the last few finished jobs.
        source tells whether a job came from the person in the app or from an agent."""
        jobs = await api.call("GET", "/api/jobs")
        active = [job_line(j) for j in reversed(jobs) if j["status"] in ("queued", "running")]
        done = [job_line(j) for j in jobs if j["status"] not in ("queued", "running")][:max(0, include_finished)]
        return [json.dumps({"queue": active, "recently_finished": done}, indent=2)]

    @mcp.tool(structured_output=False)
    async def wait_for_jobs(job_ids: list[str] | None = None, all: bool = False, timeout: float = 1800,
                            return_preview: bool = True, ctx: Context | None = None) -> list:
        """Waits for queued jobs and returns their results with images, so you can review them.

        job_ids: the jobs to wait for; by default every job that is queued or running now.
        Returns as soon as one of them finishes (all=true: when every one has), and lists the rest as
        still pending. Jobs among job_ids that already finished are returned at once. Call it again to
        collect the next. If the timeout passes first, it returns with nothing finished."""
        jobs = await api.call("GET", "/api/jobs")
        active = {j["id"] for j in jobs if j["status"] in ("queued", "running")}
        wanted = list(job_ids) if job_ids else [j["id"] for j in reversed(jobs) if j["id"] in active]
        if not wanted:
            return [json.dumps({"finished": [], "pending": [], "note": "Nothing is queued."})]
        deadline = time.time() + timeout
        while True:
            states = {jid: await api.call("GET", f"/api/jobs/{jid}") for jid in wanted}
            finished = [j for j in states.values() if j["status"] not in ("queued", "running")]
            pending = [j for j in states.values() if j["status"] in ("queued", "running")]
            if (finished and not all) or not pending or time.time() > deadline:
                break
            if ctx is not None:
                try:
                    await ctx.report_progress(len(finished), len(wanted), f"{len(pending)} jobs still running")
                except Exception:
                    pass
            await api.call("GET", f"/api/jobs/{pending[0]['id']}/wait",
                           params={"timeout": min(15, max(1, deadline - time.time()))})
        out: list = [json.dumps({"finished": [job_line(j) for j in finished],
                                 "pending": [job_line(j) for j in pending]}, indent=2)]
        for j in finished:
            out += (await api.describe_job(j, return_preview))[1:]
        return out

    @mcp.tool(structured_output=False)
    async def cancel_job(job_id: str) -> list:
        """Cancel a queued or running job."""
        return [json.dumps(await api.call("POST", f"/api/jobs/{job_id}/cancel"))]

    @mcp.tool(structured_output=False)
    async def list_images(limit: int = 20, query: str = "", favorites_only: bool = False,
                          operation: str = "") -> list:
        """Recent images in the library, newest first. query searches prompts and names;
        operation filters by generate, edit, region, expand, cutout, remix or import."""
        res = await api.call("GET", "/api/assets", params={"limit": max(1, min(200, limit)), "q": query,
                                                           "favorites": favorites_only, "op": operation})
        return [json.dumps({"total": res["total"], "images": [asset_summary(a) for a in res["items"]]}, indent=2)]

    @mcp.tool(structured_output=False)
    async def get_image(image: str, return_preview: bool = True, full_resolution: bool = False) -> list:
        """Details of one library image (prompt, parameters, lineage) and a preview.
        full_resolution returns the actual PNG instead of a small preview (large)."""
        aid = await api.image_id(image)
        a = await api.call("GET", f"/api/assets/{aid}")
        out: list = [json.dumps({**asset_summary(a), "parameters": a.get("params"), "parents": a.get("parents")},
                                indent=2)]
        if full_resolution:
            out.append(Image(path=a["path"]))
        elif return_preview:
            out.append(await api.preview(aid))
        return out

    @mcp.tool(structured_output=False)
    async def import_image(source: str, name: str = "") -> list:
        """Add an image to the library from an absolute path, URL or data: URI. Returns its id."""
        a = await api.call("POST", "/api/assets/import", json={"source": source, "name": name})
        return [json.dumps(asset_summary(a), indent=2)]

    @mcp.tool(structured_output=False)
    async def set_favorite(image: str, favorite: bool = True) -> list:
        """Star or unstar an image in the library."""
        a = await api.call("PATCH", f"/api/assets/{await api.image_id(image)}", json={"favorite": favorite})
        return [json.dumps(asset_summary(a))]

    return mcp


# ---------- stdio entry point ----------

def _alive() -> bool:
    try:
        r = httpx.get(base_url() + "/api/status", timeout=2)
        return r.status_code == 200
    except Exception:
        return False


def ensure_backend() -> None:
    """Starts a headless Mozaic in the background if none is listening. It exits after 30 idle minutes."""
    if _alive() or "MOZAIC_URL" in os.environ:
        return
    config.ensure_dirs()
    log = open(config.LOG_DIR / "headless.log", "ab")
    subprocess.Popen([sys.executable, "-m", "mozaic", "serve", "--idle-exit", "1800"], stdout=log,
                     stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True,
                     cwd=str(Path.home()))
    for _ in range(60):
        time.sleep(0.5)
        if _alive():
            return


CHANNEL_NOTE = """
When a job you queued finishes, Mozaic tells you with a <channel source="mozaic" job_id="..." status="...">
event, even while you are idle. Review the images with get_job and queue any fixes."""


def run_stdio() -> None:
    import logging

    from mcp.server.stdio import stdio_server

    logging.getLogger("httpx").setLevel(logging.WARNING)
    ensure_backend()
    server = build_mcp(channel=True)._lowlevel_server

    async def main() -> None:
        # Declaring claude/channel lets Claude Code sessions opted in to Mozaic's channel get job events.
        async with stdio_server() as (read, write):
            await server.run(read, write, server.create_initialization_options(
                experimental_capabilities={"claude/channel": {}}))

    asyncio.run(main())
