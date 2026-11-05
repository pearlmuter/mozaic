"""The job queue: turns Mozaic operations into ComfyUI runs and stores the results in the library."""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import math
import random
import time
from dataclasses import dataclass, field
from typing import Any

from PIL import Image

from . import config, estimate, graphs, imaging, installer, library
from .comfy import ComfyError, Interrupted, engine
from .moss import engines, moss_engine

log = logging.getLogger("mozaic.jobs")

OPS = ("generate", "edit", "region", "expand", "cutout", "remix")
MAX_REFS = 10
MAX_AREA = 2048 * 2048
MAX_SIDE = 2752

@dataclass
class Job:
    id: str
    op: str
    params: dict
    status: str = "queued"  # queued | paused | running | done | error | cancelled
    progress: float = 0.0
    phase: str = "Waiting"
    error: str | None = None
    outputs: list[str] = field(default_factory=list)
    text: str | None = None
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    step: int = 0
    steps: int = 0
    index: int = 0
    count: int = 1
    source: str = "app"  # app | agent (MCP)
    prompt_id: str | None = None
    moss_id: str | None = None
    cancel_requested: bool = False
    pause_requested: bool = False
    completed: int = 0  # images finished; a paused job resumes with the next one
    run_time: float = 0.0  # seconds spent running before the last pause
    position: int | None = None  # place among the waiting jobs, 0 = next
    image_started_at: float | None = None
    step_clock: tuple[int, float] | None = None  # (step, time) when the current image's sampling was first seen
    done_event: asyncio.Event = field(default_factory=asyncio.Event)

    @property
    def stopping(self) -> bool:
        return self.cancel_requested or self.pause_requested

    def images(self):
        """Indexes of the images still to make, stopping early when the job is cancelled or paused."""
        for i in range(self.completed, self.count):
            if self.stopping:
                return
            yield i
            self.completed = i + 1

    def public(self) -> dict:
        eta = estimate.remaining(self) if self.status in ("queued", "paused", "running") else None
        return {
            "id": self.id, "op": self.op, "params": self.params, "status": self.status,
            "progress": round(self.progress, 4), "phase": self.phase, "error": self.error,
            "outputs": self.outputs, "text": self.text, "created_at": self.created_at,
            "started_at": self.started_at, "finished_at": self.finished_at, "step": self.step,
            "steps": self.steps, "index": self.index, "count": self.count, "source": self.source,
            "completed": self.completed, "position": self.position,
            "eta": None if eta is None else round(eta),
        }

    def record(self) -> dict:
        return self.public()


class EventBus:
    def __init__(self) -> None:
        self.subscribers: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        self.subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.subscribers.discard(q)

    def publish(self, event: dict) -> None:
        for q in list(self.subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass


bus = EventBus()
engine.listeners.append(bus.publish)


class JobQueue:
    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}
        self.order: list[str] = []
        self.waiting: list[str] = []  # queued and paused jobs, in the order they will run
        self._wake = asyncio.Event()
        self.worker: asyncio.Task | None = None
        self.switch_after: str | None = None  # a model switch asked for while a job on the other model ran
        self._uploaded: dict[str, str] = {}
        self._last_preview = 0.0

    def start(self) -> None:
        if self.worker is None or self.worker.done():
            self.worker = asyncio.create_task(self._work())

    # ----- public API -----

    def submit(self, op: str, params: dict, source: str = "app") -> Job:
        if op not in OPS:
            raise ValueError(f"Unknown operation '{op}'. Use one of: {', '.join(OPS)}")
        params = validate(op, dict(params))
        job = Job(id=library.new_id(), op=op, params=params, count=int(params.get("count", 1)),
                  source="agent" if source == "agent" else "app")
        self.jobs[job.id] = job
        self.order.append(job.id)
        self.order = self.order[-300:]
        library.save_job(job.record())
        if op == "expand" and params["crop_only"]:
            # A plain crop or straighten is instant pixel work: do it now instead of queueing behind generations.
            job.status, job.started_at = "running", time.time()
            try:
                original, _ = library.normalize(library.open_image(params["image"]))
                framed, _ = imaging.reframe(original, params["left"], params["top"], params["right"],
                                            params["bottom"], params["angle"], "blur")
                self.store(job, framed, "Straighten" if params["angle"] else "Crop", [params["image"]], params["seed"])
                self._finish(job, "done")
            except Exception as e:
                log.exception("crop %s failed", job.id)
                self._finish(job, "error", str(e) or e.__class__.__name__)
            return job
        self.waiting.append(job.id)
        self._renumber()
        self._changed(job)
        self._wake.set()
        self.start()
        return job

    def restore(self) -> None:
        """Jobs that were waiting or running when Mozaic last quit come back paused, in their old order."""
        for d in library.unfinished_jobs():
            if d["id"] in self.jobs:
                continue
            p = d["params"] or {}
            job = Job(id=d["id"], op=d["op"], params=p, status="paused", phase="Paused", outputs=d["outputs"],
                      created_at=d["created_at"], count=int(p.get("count", 1)), source=d.get("source") or "app")
            job.completed = job.index = min(job.count, len(job.outputs))
            job.progress = job.completed / max(1, job.count)
            self.jobs[job.id] = job
            self.order.append(job.id)
            self.waiting.append(job.id)
            library.save_job(job.record())
        self._renumber()

    def get(self, jid: str) -> dict | None:
        if jid in self.jobs:
            return self.jobs[jid].public()
        return library.load_job(jid)

    def list(self) -> list[dict]:
        return [self.jobs[j].public() for j in reversed(self.order) if j in self.jobs]

    async def cancel(self, jid: str) -> bool:
        job = self.jobs.get(jid)
        if not job or job.status not in ("queued", "paused", "running"):
            return False
        job.cancel_requested = True
        if job.status in ("queued", "paused"):
            self._finish(job, "cancelled")
        else:
            await self._interrupt(job)
        return True

    async def pause(self, jid: str) -> bool:
        """A waiting job is held until resumed. A running one stops now and goes back first in line, keeping
        the images it finished; the image it was on starts over when it resumes."""
        job = self.jobs.get(jid)
        if not job or job.status not in ("queued", "running") or job.stopping:
            return False
        if job.status == "queued":
            job.status, job.phase = "paused", "Paused"
            library.save_job(job.record())
            self._changed(job)
        else:
            job.pause_requested = True
            job.phase = "Pausing"
            self._changed(job)
            await self._interrupt(job)
        return True

    def resume(self, jid: str) -> bool:
        job = self.jobs.get(jid)
        if not job or job.status != "paused":
            return False
        job.status, job.phase = "queued", "Waiting"
        library.save_job(job.record())
        self._changed(job)
        self._wake.set()
        return True

    def reorder(self, ids: list[str]) -> list[str]:
        """Puts the waiting jobs in the given order; waiting jobs left out keep their order after them."""
        known = [j for j in dict.fromkeys(ids) if j in self.waiting]
        self.waiting = known + [j for j in self.waiting if j not in known]
        self._renumber(publish=True)
        return list(self.waiting)

    async def _interrupt(self, job: Job) -> None:
        if job.moss_id:
            moss_engine.cancel(job.moss_id)
        elif job.prompt_id:
            await engine.interrupt(job.prompt_id)

    async def wait(self, jid: str, timeout: float) -> dict | None:
        job = self.jobs.get(jid)
        if not job:
            return library.load_job(jid)
        try:
            await asyncio.wait_for(job.done_event.wait(), timeout)
        except asyncio.TimeoutError:
            pass
        return job.public()

    def running_model(self) -> str | None:
        return next((job_model(j) for j in self.jobs.values() if j.status == "running"), None)

    def request_switch(self, model: str) -> bool:
        """Switching models stops the other engine, which would kill a running job. Returns True when the
        switch has to wait for the running job, and remembers it for then."""
        running = self.running_model()
        if running is None or running == model:
            self.switch_after = None
            return False
        self.switch_after = model
        return True

    async def _apply_switch(self) -> None:
        model, self.switch_after = self.switch_after, None
        nxt = self._next()
        # The next job switches to its own model anyway; only switch now if it would want this one too.
        if model and (nxt is None or job_model(nxt) == model):
            try:
                await engines.use(model)
            except Exception:
                log.exception("switching to %s failed", model)

    def pending(self) -> int:
        return sum(1 for j in self.jobs.values() if j.status in ("queued", "running"))

    # ----- internals -----

    def _changed(self, job: Job) -> None:
        bus.publish({"type": "job", "job": job.public()})

    def _renumber(self, publish: bool = False) -> None:
        for i, jid in enumerate(self.waiting):
            job = self.jobs[jid]
            moved = job.position != i
            job.position = i
            if publish and moved:
                library.save_job(job.record())
                self._changed(job)

    def _finish(self, job: Job, status: str, error: str | None = None) -> None:
        job.status, job.error = status, error
        job.finished_at = time.time()
        job.position = None
        if status == "done":
            job.progress, job.phase = 1.0, "Done"
            estimate.invalidate()
        elif status == "cancelled":
            job.phase = "Cancelled"
        else:
            job.phase = "Failed"
        library.save_job(job.record())
        job.done_event.set()
        self._changed(job)
        if job.id in self.waiting:
            self.waiting.remove(job.id)
            self._renumber(publish=True)

    def _paused(self, job: Job) -> None:
        """Puts a job that was stopped by pause() back at the front of the queue."""
        job.status, job.phase, job.pause_requested = "paused", "Paused", False
        job.run_time = time.time() - (job.started_at or time.time())
        job.prompt_id = job.moss_id = None
        job.step = 0
        job.index = job.completed
        job.progress = job.completed / max(1, job.count)
        self.waiting.insert(0, job.id)
        self._renumber(publish=True)
        library.save_job(job.record())
        self._changed(job)

    def _settle(self, job: Job, error: Exception | None = None) -> None:
        if job.cancel_requested:
            self._finish(job, "cancelled")
        elif job.pause_requested:
            self._paused(job)
        elif error is not None:
            msg = str(error) or error.__class__.__name__
            if "out of memory" in msg.lower():
                msg = ("Not enough memory for this size. Try a smaller output size or fewer reference images, "
                       "or close other apps. (" + msg.split(".")[0].strip() + ")")
            self._finish(job, "error", msg)
        else:
            self._finish(job, "done")

    def _next(self) -> Job | None:
        return next((self.jobs[j] for j in self.waiting if self.jobs[j].status == "queued"), None)

    async def _work(self) -> None:
        while True:
            job = self._next()
            if job is None:
                self._wake.clear()
                await self._wake.wait()
                continue
            self.waiting.remove(job.id)
            job.position = None
            self._renumber(publish=True)
            job.status, job.phase = "running", "Starting engine"
            # Time spent paused doesn't count, so finished - started stays the job's real running time.
            job.started_at = time.time() - job.run_time
            self._changed(job)
            try:
                model = job_model(job)
                if engines.active != model:
                    job.phase = "Switching model"
                    self._changed(job)
                    await engines.use(model, start=False)
                await engines.get(model).ensure_ready()
                await (run_moss_generate if model == "moss" else RUNNERS[job.op])(self, job)
                self._settle(job)
            except Interrupted:
                if job.pause_requested and not job.cancel_requested:
                    self._paused(job)
                else:
                    self._finish(job, "cancelled")
            except Exception as e:
                if not job.stopping:
                    log.exception("job %s failed", job.id)
                self._settle(job, e)
            if self.switch_after:
                await self._apply_switch()

    async def upload(self, aid: str) -> tuple[str, bool]:
        a = library.get(aid)
        if not a:
            raise ValueError(f"Unknown image id {aid}")
        key = f"{aid}@{engine.started_at}"
        if key not in self._uploaded:
            with open(a["path"], "rb") as f:
                self._uploaded[key] = await engine.upload_image(f.read(), f"mozaic_{aid}.png")
        return self._uploaded[key], a["has_alpha"]

    async def upload_image(self, img: Image.Image, name: str) -> tuple[str, bool]:
        img, alpha = library.normalize(img)
        return await engine.upload_image(imaging.png_bytes(img), name), alpha

    async def run_graph(self, job: Job, graph: dict, index: int) -> dict:
        job.index, job.step, job.step_clock, job.image_started_at = index, 0, None, time.time()
        job.steps = int(job.params.get("steps", 0))
        job.phase = "Queued in engine"
        self._changed(job)

        async def on_event(msg: dict) -> None:
            t, d = msg["type"], msg.get("data", {})
            if t == "queued":
                job.prompt_id = d["prompt_id"]
                if job.stopping:
                    await engine.interrupt(job.prompt_id)
            elif t == "execution_start":
                job.phase = "Preparing"
            elif t == "executing" and d.get("node"):
                ct = graph.get(str(d["node"]), {}).get("class_type", "")
                job.phase = PHASES.get(ct, job.phase)
            elif t == "progress":
                ct = graph.get(str(d.get("node")), {}).get("class_type", "")
                if ct == "KSampler":
                    job.step, job.steps = int(d["value"]), int(d["max"])
                    job.step_clock = job.step_clock or (job.step, time.time())
                    job.phase = "Generating"
            elif t == "preview":
                now = time.time()
                if now - self._last_preview > 0.25:
                    self._last_preview = now
                    bus.publish({"type": "preview", "job_id": job.id,
                                 "image": "data:image/jpeg;base64," + base64.b64encode(d["image"]).decode()})
                return
            else:
                return
            frac = job.step / job.steps if job.steps else 0.0
            job.progress = min(0.99, (index + frac * 0.95) / max(1, job.count))
            self._changed(job)

        return await engine.run(graph, on_event)

    async def images_from(self, outputs: dict) -> list[Image.Image]:
        result = []
        for node_out in outputs.values():
            for im in node_out.get("images", []):
                data = await engine.fetch_output(im["filename"], im.get("subfolder", ""), im.get("type", "output"))
                img = Image.open(io.BytesIO(data))
                img.load()
                result.append(img)
        return result

    def store(self, job: Job, img: Image.Image, prompt: str, parents: list[str], seed: int) -> dict:
        params = dict(job.params, seed=seed)
        asset = library.add_image(img, source="generated", op=job.op, prompt=prompt, params=params,
                                  parents=parents, job_id=job.id)
        job.outputs.append(asset["id"])
        bus.publish({"type": "asset", "asset": asset})
        return asset


PHASES = {
    "UNETLoader": "Loading image model", "CLIPLoader": "Loading text encoder", "VAELoader": "Loading VAE",
    "LoraLoaderModelOnly": "Applying LoRA", "TextEncodeQwenImage21": "Reading prompt and images",
    "LoadImage": "Loading images", "VAEEncode": "Encoding image", "KSampler": "Generating",
    "VAEDecode": "Decoding", "SaveImage": "Saving",
}


# ---------- parameter handling ----------

def _seed(v: Any) -> int:
    try:
        v = int(v)
    except (TypeError, ValueError):
        v = -1
    return random.randint(0, 2**50) if v < 0 else v


def job_model(job: Job) -> str:
    return "moss" if job.op == "generate" and job.params.get("model") == "moss" else "qwen"


def validate(op: str, p: dict) -> dict:
    s = config.load_settings()
    if op == "generate" and (p.get("model") or s.active_model) == "moss":
        return validate_moss(p)
    p["model"] = "qwen"
    p.setdefault("negative_prompt", "")
    p["steps"] = max(1, min(150, int(p.get("steps") or s.steps)))
    p["cfg"] = float(p.get("cfg") if p.get("cfg") is not None else s.cfg)
    p["sampler"] = p.get("sampler") or s.sampler
    p["scheduler"] = p.get("scheduler") or s.scheduler
    p["seed"] = _seed(p.get("seed", -1))
    p["count"] = max(1, min(16, int(p.get("count") or 1)))
    p["loras"] = [l for l in p.get("loras") or [] if l.get("name")]
    if op in ("generate", "edit", "region") and not (p.get("prompt") or "").strip():
        raise ValueError("A prompt is required")
    if op == "generate":
        aspect = p.get("aspect") or "1:1"
        if p.get("width") and p.get("height"):
            w, h = int(p["width"]), int(p["height"])
        else:
            if aspect in config.ASPECT_RATIOS:
                aw, ah = config.ASPECT_RATIOS[aspect]
            else:
                try:
                    aw, ah = (float(x) for x in str(aspect).split(":"))
                except ValueError:
                    raise ValueError(f"Bad aspect ratio '{aspect}'")
            mp = float(p.get("megapixels") or s.megapixels)
            w, h = graphs.size_for(aw / ah, max(0.25, min(4.5, mp)))
        if w * h > MAX_AREA * 1.35 or max(w, h) > 3072:
            raise ValueError(f"{w}x{h} is larger than the model supports (about 2048x2048, longest side 2752)")
        p["width"], p["height"] = graphs.snap32(w), graphs.snap32(h)
        p["transparent"] = bool(p.get("transparent"))
    if op in ("edit",):
        imgs = p.get("images") or []
        if not imgs:
            raise ValueError("Edit needs at least one image")
        if len(imgs) > MAX_REFS:
            raise ValueError(f"Qwen Image 2.1 takes up to {MAX_REFS} images")
        for a in imgs:
            _need(a)
    if op in ("region", "expand", "cutout", "remix"):
        _need(p.get("image"))
    if op == "region":
        _need(p.get("mask"))
        p["method"] = p.get("method") or "outline"
        if p["method"] not in ("outline", "mask", "repaint"):
            raise ValueError("method must be outline, mask or repaint")
        refs = p.get("references") or []
        limit = MAX_REFS - (2 if p["method"] == "mask" else 1)
        if len(refs) > limit:
            raise ValueError(f"At most {limit} reference images with the '{p['method']}' method")
        for a in refs:
            _need(a)
        p.setdefault("protect", True)
        p["grow"] = int(p.get("grow", 8))
        p["feather"] = int(p.get("feather", 12))
        p["strength"] = float(p.get("strength", 1.0))
    if op == "expand":
        # Positive sides grow the canvas, negative ones crop; `angle` straightens (degrees, clockwise).
        a = library.get(p["image"])
        for k in ("left", "top", "right", "bottom"):
            p[k] = int(p.get(k) or 0)
        p["angle"] = max(-45.0, min(45.0, float(p.get("angle") or 0)))
        if a["width"] + p["left"] + p["right"] < 16 or a["height"] + p["top"] + p["bottom"] < 16:
            raise ValueError("The crop leaves almost nothing of the image")
        if not p["angle"] and not any(p[k] for k in ("left", "top", "right", "bottom")):
            raise ValueError("Give at least one side to expand or crop, or an angle to straighten")
        # A frame the photo fills completely needs no model: it is cropped and straightened directly.
        p["crop_only"] = imaging.frame_covered(a["width"], a["height"], p["left"], p["top"], p["right"],
                                               p["bottom"], p["angle"])
        if p["crop_only"]:
            p["count"] = 1
        p.setdefault("fill", "blur")
        p.setdefault("protect", True)
        p["feather"] = int(p.get("feather", 24))
    if op == "remix":
        p["strength"] = max(0.02, min(1.0, float(p.get("strength", 0.45))))
        p["scale"] = max(0.25, min(4.0, float(p.get("scale", 1.0))))
        p.setdefault("use_reference", False)
    return p


def _need(aid: Any) -> None:
    if not aid or not library.get(str(aid)):
        raise ValueError(f"Unknown image id '{aid}'")


def _sampling(p: dict, seed: int, denoise: float = 1.0) -> graphs.Sampling:
    return graphs.Sampling(seed=seed, steps=p["steps"], cfg=p["cfg"], sampler=p["sampler"],
                           scheduler=p["scheduler"], denoise=denoise)


async def model_set(loras: list[dict] | None = None) -> graphs.ModelSet:
    s = config.load_settings()
    unets = await engine.choices("UNETLoader", "unet_name")
    tes = await engine.choices("CLIPLoader", "clip_name")
    vaes = await engine.choices("VAELoader", "vae_name")

    def pick(current: str, options: list[str], *needles: str) -> str:
        if current and current in options:
            return current
        for o in options:
            if all(n in o.lower() for n in needles):
                return o
        raise ComfyError(f"No model matching {' '.join(needles)} found in ComfyUI's model folders")

    return graphs.ModelSet(
        unet=pick(s.unet, unets, "qwen_image_2.1"),
        text_encoder=pick(s.text_encoder, tes, "qwen3vl_8b"),
        vae=pick(s.vae, vaes, "qwen_image_2.1_vae"),
        weight_dtype=s.weight_dtype, cache_device=s.cache_device, cache_dtype=s.cache_dtype,
        loras=loras or [],
    )


def kv_cache(m: graphs.ModelSet, images: int, side: int) -> None:
    """Mozaic's "auto" for the edit KV cache, sized for `images` reference images at `side`² pixels.

    ComfyUI's own auto keeps the cache in GPU memory whenever the Mac reports free memory, but on unified
    memory that is the same RAM, inside Metal's capped pool, and big edits ran out of it or into swap.
    Kept in RAM it stays outside the pool at little cost in speed; int8 halves it once the references are big.
    """
    if m.cache_device != "auto":
        return
    m.cache_device = "cpu"
    if m.cache_dtype == "default" and images * side * side >= 2 * 1024 * 1024:
        m.cache_dtype = "int8"


def _match_resolution(w: int, h: int, requested: Any) -> int:
    """Edit resolution budget. 'match' (default) keeps the input size, capped at 2048x2048."""
    if requested in (None, "", "match"):
        return graphs.snap32(min(2048, math.sqrt(w * h)))
    return max(0, min(2048, int(requested)))


def transparent_prompt(prompt: str) -> str:
    body = prompt.strip()
    if body.lower().startswith("this is an rgba"):
        return body
    if body and body[-1] not in ".!?":
        body += "."
    return config.RGBA_PREFIX + body + config.RGBA_SUFFIX


# ---------- runners ----------

async def run_generate(q: JobQueue, job: Job) -> None:
    p = job.params
    prompt = transparent_prompt(p["prompt"]) if p["transparent"] else p["prompt"]
    m = await model_set(p["loras"])
    for i in job.images():
        seed = p["seed"] + i
        g = graphs.text_to_image(m, _sampling(p, seed), prompt, p["negative_prompt"], p["width"], p["height"])
        for img in await q.images_from(await q.run_graph(job, g, i)):
            q.store(job, img, p["prompt"], [], seed)


async def run_edit(q: JobQueue, job: Job) -> None:
    p = job.params
    prompt = p["prompt"]
    if p.get("transparent"):
        prompt = prompt.rstrip(". ") + ". Output a PNG image with a transparent background."
    m = await model_set(p["loras"])
    uploads = [await q.upload(a) for a in p["images"]]
    first = library.get(p["images"][0])
    res = _match_resolution(first["width"], first["height"], p.get("resolution"))
    kv_cache(m, len(uploads), res)
    size = (int(p["width"]), int(p["height"])) if p.get("width") and p.get("height") else None
    for i in job.images():
        seed = p["seed"] + i
        g = graphs.edit(m, _sampling(p, seed), prompt, p["negative_prompt"], uploads, res, size)
        for img in await q.images_from(await q.run_graph(job, g, i)):
            q.store(job, img, p["prompt"], list(p["images"]), seed)


async def run_region(q: JobQueue, job: Job) -> None:
    p = job.params
    m = await model_set(p["loras"])
    original = library.open_image(p["image"])
    original, _ = library.normalize(original)
    mask = imaging.to_mask(library.open_image(p["mask"]), original.size)
    if not imaging.mask_bbox(mask):
        raise ValueError("The mask is empty. Paint over the area you want to change.")
    method = p["method"]
    refs = [await q.upload(a) for a in p.get("references") or []]
    res = _match_resolution(original.width, original.height, p.get("resolution"))
    outline_w = max(4, round(min(original.size) / 160))
    instruction = p["prompt"].strip().rstrip(".")

    if method == "outline":
        marked = imaging.draw_outline(original, mask, width=outline_w)
        target = await q.upload_image(marked, f"mozaic_{job.id}_marked.png")
        prompt = (f"In <image1>, change only the area outlined in red: {instruction}. "
                  "Remove the red outline completely and keep everything outside it exactly the same.")
        keep_mask = imaging.grow(mask, outline_w + p["grow"])
    elif method == "mask":
        target = await q.upload(p["image"])
        mref = await q.upload_image(imaging.mask_reference(mask), f"mozaic_{job.id}_maskref.png")
        refs = [mref] + refs
        prompt = (f"<image2> is a black-and-white mask for <image1>. Change only the part of <image1> under the "
                  f"white area of the mask: {instruction}. Keep everything else exactly the same.")
        keep_mask = imaging.grow(mask, p["grow"])
    else:
        target = await q.upload(p["image"])
        prompt = instruction
        keep_mask = imaging.grow(mask, p["grow"])
    kv_cache(m, 1 + len(refs), res)

    for i in job.images():
        seed = p["seed"] + i
        if method == "repaint":
            mname, _ = await q.upload_image(imaging.mask_reference(imaging.grow(mask, p["grow"])),
                                            f"mozaic_{job.id}_mask.png")
            w, h = graphs.size_for(original.width / original.height, (res * res) / (1024 * 1024))
            g = graphs.repaint(m, _sampling(p, seed, p["strength"]), prompt, p["negative_prompt"], target, mname,
                               refs, w, h)
        else:
            g = graphs.edit(m, _sampling(p, seed), prompt, p["negative_prompt"], [target] + refs, res)
        for img in await q.images_from(await q.run_graph(job, g, i)):
            if p["protect"]:
                img = imaging.composite(original, img, keep_mask, p["feather"])
            q.store(job, img, p["prompt"], [p["image"], p["mask"], *(p.get("references") or [])], seed)


async def run_expand(q: JobQueue, job: Job) -> None:
    p = job.params
    original, _ = library.normalize(library.open_image(p["image"]))
    padded, new_area = imaging.reframe(original, p["left"], p["top"], p["right"], p["bottom"], p.get("angle", 0),
                                       p["fill"])
    if padded.width * padded.height > MAX_AREA * 1.35:
        scale = math.sqrt(MAX_AREA / (padded.width * padded.height))
        padded = padded.resize((round(padded.width * scale), round(padded.height * scale)), Image.Resampling.LANCZOS)
        new_area = new_area.resize(padded.size)
    m = await model_set(p["loras"])
    target = await q.upload_image(padded, f"mozaic_{job.id}_padded.png")
    fill_word = {"transparent": "transparent", "blur": "blurred", "gray": "plain gray", "black": "plain black"}.get(
        p["fill"], "plain white")
    extra = (p.get("prompt") or "").strip().rstrip(".")
    prompt = (f"Fill the {fill_word} border areas of <image1> by naturally extending the scene outward, matching "
              f"perspective, lighting and style, so the result looks like one seamless photo. Keep the existing "
              f"content unchanged.{' ' + extra + '.' if extra else ''}")
    res = _match_resolution(padded.width, padded.height, p.get("resolution"))
    kv_cache(m, 1, res)
    keep = imaging.grow(new_area, p["feather"])
    for i in job.images():
        seed = p["seed"] + i
        g = graphs.edit(m, _sampling(p, seed), prompt, p["negative_prompt"], [target], res)
        for img in await q.images_from(await q.run_graph(job, g, i)):
            if p["protect"]:
                img = imaging.composite(padded, img, keep, p["feather"])
            q.store(job, img, extra or "Expand canvas", [p["image"]], seed)


async def run_cutout(q: JobQueue, job: Job) -> None:
    p = job.params
    m = await model_set(p["loras"])
    subject = (p.get("subject") or "").strip()
    if subject:
        prompt = (f"Extract the {subject} from the image and remove everything else, and output a PNG image with a "
                  "transparent background")
    else:
        prompt = "Remove the background, and output a PNG image"
    target = await q.upload(p["image"])
    a = library.get(p["image"])
    res = _match_resolution(a["width"], a["height"], p.get("resolution"))
    kv_cache(m, 1, res)
    for i in job.images():
        seed = p["seed"] + i
        g = graphs.edit(m, _sampling(p, seed), prompt, p["negative_prompt"], [target], res)
        for img in await q.images_from(await q.run_graph(job, g, i)):
            q.store(job, img, subject or "Remove background", [p["image"]], seed)


async def run_remix(q: JobQueue, job: Job) -> None:
    p = job.params
    m = await model_set(p["loras"])
    a = library.get(p["image"])
    w, h = a["width"] * p["scale"], a["height"] * p["scale"]
    if w * h > MAX_AREA * 1.1:
        f = math.sqrt(MAX_AREA * 1.1 / (w * h))
        w, h = w * f, h * f
    if max(w, h) > MAX_SIDE:
        f = MAX_SIDE / max(w, h)
        w, h = w * f, h * f
    target = await q.upload(p["image"])
    if p["use_reference"]:
        kv_cache(m, 1, int(math.sqrt(w * h)))
    prompt = (p.get("prompt") or "").strip() or "High quality, sharp, detailed image."
    for i in job.images():
        seed = p["seed"] + i
        g = graphs.remix(m, _sampling(p, seed, p["strength"]), prompt, p["negative_prompt"], target, int(w), int(h),
                         bool(p["use_reference"]))
        for img in await q.images_from(await q.run_graph(job, g, i)):
            q.store(job, img, p.get("prompt") or "Remix", [p["image"]], seed)


# ---------- MOSS-Image ----------

MOSS_MIN_AREA = 256 * 256
MOSS_MAX_AREA = 1456 * 1456


def snap16(v: float) -> int:
    return max(16, int(round(v / 16)) * 16)


def validate_moss(p: dict) -> dict:
    """MOSS-Image text-to-image (plain or JSON layout prompt). Official defaults: 50 steps, CFG 3, shift 5."""
    s = config.load_settings()
    p["model"] = "moss"
    layout = p.get("layout")
    if layout:
        if isinstance(layout, str):
            import json as _json

            layout = _json.loads(layout)
        layout.setdefault("bbox_format", "yxyx")
        layout.setdefault("bbox_coord_space", "abs_centralized")
        if not (layout.get("summary") or {}).get("caption"):
            raise ValueError("A layout needs summary.caption: describe the whole image")
        p["layout"] = layout
        import json as _json

        p["prompt"] = _json.dumps(layout, ensure_ascii=False)
    if not (p.get("prompt") or "").strip():
        raise ValueError("A prompt is required")
    p.setdefault("negative_prompt", "")
    p["turbo"] = bool(p.get("turbo"))
    p["checkpoint"] = p.get("checkpoint") or s.moss_checkpoint
    if p["checkpoint"] not in ("sft", "base"):
        raise ValueError("checkpoint must be sft or base")
    if p["turbo"] and p["checkpoint"] != "sft":
        raise ValueError("Turbo works with the SFT checkpoint only")
    p["steps"] = max(1, min(200, int(p.get("steps") or 50)))
    p["cfg"] = float(p["cfg"]) if p.get("cfg") is not None else 3.0
    p["shift"] = float(p["shift"]) if p.get("shift") is not None else 5.0
    # MOSS seeds numpy's generator, which takes 0..2**32-1.
    seed = int(p.get("seed", -1) if p.get("seed") is not None else -1)
    if seed >= 2**32:
        raise ValueError("MOSS-Image seeds go from 0 to 4294967295")
    p["count"] = max(1, min(16, int(p.get("count") or 1)))
    p["seed"] = random.randint(0, 2**32 - 1 - p["count"]) if seed < 0 else min(seed, 2**32 - p["count"])
    p["loras"] = [l for l in p.get("loras") or [] if l.get("name")]
    for l in p["loras"]:
        if not moss_lora_path(l["name"]):
            raise ValueError(f"LoRA not found: {l['name']}")
    if p.get("width") and p.get("height"):
        w, h = int(p["width"]), int(p["height"])
    else:
        try:
            aw, ah = (float(x) for x in str(p.get("aspect") or "1:1").split(":"))
        except ValueError:
            raise ValueError(f"Bad aspect ratio '{p.get('aspect')}'")
        mp = max(0.0625, min(2.02, float(p.get("megapixels") or 1.0)))
        area = mp * 1024 * 1024
        w, h = math.sqrt(area * aw / ah), math.sqrt(area * ah / aw)
    w, h = snap16(w), snap16(h)
    if not MOSS_MIN_AREA <= w * h <= MOSS_MAX_AREA * 1.02:
        raise ValueError(f"{w}x{h} is outside MOSS-Image's range (256x256 to about 1456x1456)")
    p["width"], p["height"] = w, h
    return p


def moss_lora_dirs() -> list:
    s = config.load_settings()
    from pathlib import Path

    dirs = [installer.MODELS_DIR / "loras", installer.MOSS_DIR / "loras"]
    dirs += [Path(d) / "loras" for d in s.models_dirs]
    return [d for d in dirs if d.is_dir()]


def moss_loras() -> list[str]:
    names = []
    for d in moss_lora_dirs():
        names += [f.name for f in sorted(d.glob("*.safetensors"))]
    return sorted(set(names))


def moss_lora_path(name: str):
    for d in moss_lora_dirs():
        if (d / name).is_file():
            return d / name
    return None


def moss_config(p: dict) -> dict:
    s = config.load_settings()
    cfg = {
        "model_dir": str(installer.MOSS_SFT),
        "transformer_dir": str(installer.MOSS_BASE_TRANSFORMER) if p["checkpoint"] == "base" else None,
        "keep_resident": s.moss_keep_resident,
        "cache_dir": str(config.APP_SUPPORT / "cache" / "moss-prompts"),
        "turbo": p["turbo"],
        "loras": [{"path": str(moss_lora_path(l["name"])), "strength": float(l.get("strength", 1.0))}
                  for l in p["loras"]],
    }
    if p["turbo"]:
        cfg["student"] = str(installer.MOSS_TURBO_STUDENT)
        cfg["destripe"] = str(installer.MOSS_TURBO_DESTRIPE)
    return cfg


async def run_moss_generate(q: JobQueue, job: Job) -> None:
    p = job.params
    cfg = moss_config(p)
    out_dir = config.APP_SUPPORT / "moss-out"
    for i in job.images():
        seed = p["seed"] + i
        job.index, job.step, job.steps = i, 0, (15 if p["turbo"] else p["steps"])
        job.step_clock, job.image_started_at = None, time.time()
        job.phase = "Queued in engine"
        q._changed(job)

        def on_event(msg: dict, i=i) -> None:
            if msg["type"] == "phase":
                job.phase = msg["phase"]
            elif msg["type"] == "progress":
                job.step, job.steps = msg["step"], msg["total"]
                job.step_clock = job.step_clock or (job.step, time.time())
                job.phase = "Generating"
            frac = job.step / job.steps if job.steps else 0.0
            job.progress = min(0.99, (i + frac * 0.95) / max(1, job.count))
            q._changed(job)

        request = {"prompt": p["prompt"], "negative_prompt": p["negative_prompt"], "width": p["width"],
                   "height": p["height"], "steps": p["steps"], "guidance": p["cfg"], "shift": p["shift"],
                   "seed": seed, "turbo": p["turbo"]}
        out = out_dir / f"{job.id}-{i}.png"
        ref: dict = {}
        task = asyncio.create_task(moss_engine.run(cfg, request, out, on_event, ref))
        while not task.done():
            job.moss_id = ref.get("moss_id")
            if job.stopping and job.moss_id:
                moss_engine.cancel(job.moss_id)
            await asyncio.sleep(0.2)
        await task
        img = Image.open(out)
        img.load()
        prompt_text = (p.get("layout") or {}).get("summary", {}).get("caption") if p.get("layout") else p["prompt"]
        q.store(job, img, prompt_text or p["prompt"], [], seed)
        out.unlink(missing_ok=True)


RUNNERS = {
    "generate": run_generate, "edit": run_edit, "region": run_region, "expand": run_expand,
    "cutout": run_cutout, "remix": run_remix,
}

queue = JobQueue()
