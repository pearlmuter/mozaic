"""HTTP API, live event stream, static UI and the MCP endpoint, all on one port."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import io
import json
import logging
import re
import subprocess
import sys
import time
from pathlib import Path

import httpx
from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image

from . import __version__, config, imaging, library
from .comfy import engine
from .installer import installers
from .moss import engines, moss_engine
from .jobs import OPS, bus, queue

log = logging.getLogger("mozaic.server")

WEB_DIST = Path(__file__).resolve().parent / "web"
if not WEB_DIST.exists():
    WEB_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"


class Activity:
    """Tracks when Mozaic was last used, for idle shutdown of headless instances."""

    def __init__(self) -> None:
        self.last = time.time()
        self.ui_clients = 0

    def touch(self) -> None:
        self.last = time.time()


activity = Activity()


def create_app(idle_exit: float = 0) -> FastAPI:
    from .mcp_server import build_mcp

    mcp = build_mcp()
    mcp_app = mcp.streamable_http_app(streamable_http_path="/mcp")

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        config.ensure_dirs()
        library.db()
        queue.restore()
        queue.start()
        engines.listeners.append(bus.publish)
        moss_engine.listeners.append(bus.publish)
        for model, inst in installers.items():
            inst.listeners.append(bus.publish)
            inst.on_ready = lambda m=model: engines.active == m and asyncio.create_task(engines.get(m).start())
        active = engines.active
        if _needs_setup(active):
            # First run: install the engine and models. Headless servers (started for MCP) leave that to the app.
            if idle_exit == 0:
                installers[active].start()
        elif config.load_settings().auto_start_engine:
            asyncio.create_task(engines.get(active).start())
        idle_task = asyncio.create_task(_idle_watch(idle_exit)) if idle_exit > 0 else None
        try:
            async with mcp.session_manager.run():
                yield
        finally:
            if idle_task:
                idle_task.cancel()
            await engine.stop()
            await moss_engine.stop()

    app = FastAPI(title="Mozaic", version=__version__, lifespan=lifespan)

    @app.middleware("http")
    async def touch(request: Request, call_next):
        activity.touch()
        return await call_next(request)

    # ---------- status & engine ----------

    @app.get("/api/status")
    async def status():
        return {
            "version": __version__,
            "active_model": engines.active,
            "engine": engines.get(engines.active).status(),
            "engines": engines.statuses(),
            "setup": installers[engines.active].public(),
            "setups": {m: i.public() for m, i in installers.items()},
            "pending_jobs": queue.pending(),
            "library_count": library.count_assets(),
            "library_dir": config.load_settings().library_dir,
            "mcp_url": f"http://127.0.0.1:{getattr(app.state, 'port', config.DEFAULT_PORT)}/mcp",
            "mcp_command": [sys.executable, "-m", "mozaic", "mcp"],
        }

    @app.post("/api/engine/{action}")
    async def engine_action(action: str):
        if action == "start":
            asyncio.create_task(engine.start())
        elif action == "stop":
            await engine.stop()
        elif action == "restart":
            await engine.stop()
            asyncio.create_task(engine.start())
        elif action == "free":
            await engine.free_memory()
        else:
            raise HTTPException(404, "Unknown action")
        return engine.status()

    def _installer(model: str | None):
        model = model or engines.active
        if model not in installers:
            raise HTTPException(404, f"Unknown model '{model}'")
        return installers[model]

    @app.get("/api/setup")
    async def setup_status(model: str | None = None):
        inst = _installer(model)
        inst.refresh()
        return inst.public()

    @app.post("/api/setup/start")
    async def setup_start(model: str | None = None):
        inst = _installer(model)
        inst.start()
        return inst.public()

    @app.post("/api/setup/cancel")
    async def setup_cancel(model: str | None = None):
        inst = _installer(model)
        await inst.cancel()
        return inst.public()

    @app.post("/api/model")
    async def set_model(body: dict = Body(...)):
        model = body.get("model", "")
        if model not in ("qwen", "moss"):
            raise HTTPException(400, f"Unknown model '{model}'")
        # Never stop the engine under a running job: the switch happens once that job is done.
        if queue.request_switch(model):
            return {"active_model": engines.active, "engines": engines.statuses(), "switch_after": model}
        await engines.use(model)
        return {"active_model": engines.active, "engines": engines.statuses()}

    @app.get("/api/moss")
    async def moss_info():
        from .jobs import moss_loras

        s = config.load_settings()
        return {"loras": moss_loras(), "checkpoint": s.moss_checkpoint, "keep_resident": s.moss_keep_resident,
                "checkpoints": ["sft", "base"]}

    @app.get("/api/models")
    async def models():
        if engines.active != "qwen":
            raise HTTPException(409, "Qwen Image 2.1 isn't the active model")
        try:
            await engine.ensure_ready()
        except Exception as e:
            raise HTTPException(503, str(e))
        from .jobs import model_set
        try:
            current = await model_set()
            selected = {"unet": current.unet, "text_encoder": current.text_encoder, "vae": current.vae}
        except Exception as e:
            selected = {"error": str(e)}
        return {
            "unet": await engine.choices("UNETLoader", "unet_name"),
            "text_encoder": await engine.choices("CLIPLoader", "clip_name"),
            "vae": await engine.choices("VAELoader", "vae_name"),
            "loras": await engine.choices("LoraLoaderModelOnly", "lora_name"),
            "samplers": await engine.choices("KSampler", "sampler_name"),
            "schedulers": await engine.choices("KSampler", "scheduler"),
            "weight_dtypes": await engine.choices("UNETLoader", "weight_dtype"),
            "selected": selected,
        }

    @app.get("/api/settings")
    async def get_settings():
        return config.settings_dict()

    @app.put("/api/settings")
    async def put_settings(updates: dict = Body(...)):
        before = config.settings_dict()
        s = config.save_settings(updates)
        engine_keys = ("comfy_mode", "comfy_path", "comfy_url", "comfy_port", "models_dirs")
        if any(before.get(k) != getattr(s, k) for k in engine_keys):
            engine.invalidate_object_info()
            await engine.stop()
            installers["qwen"].refresh()
            if engines.active == "qwen":
                if _needs_setup("qwen"):
                    installers["qwen"].start()
                else:
                    asyncio.create_task(engine.start())
        return config.settings_dict()

    @app.get("/api/info")
    async def info():
        return {
            "ops": OPS,
            "aspect_ratios": config.ASPECT_RATIOS,
            "max_references": 10,
            "rgba_prefix": config.RGBA_PREFIX,
            "rgba_suffix": config.RGBA_SUFFIX,
        }

    # ---------- assets ----------

    @app.get("/api/assets")
    async def list_assets(limit: int = 100, offset: int = 0, q: str = "", favorites: bool = False, op: str = ""):
        return {"items": library.list_assets(limit, offset, q, favorites, op), "total": library.count_assets()}

    @app.post("/api/assets/upload")
    async def upload(files: list[UploadFile] = File(...), hidden: bool = Form(False)):
        out = []
        for f in files:
            try:
                out.append(library.import_bytes(await f.read(), f.filename or "", hidden))
            except Exception as e:
                raise HTTPException(400, f"{f.filename}: not a readable image ({e})")
        for a in out:
            if not a["hidden"]:
                bus.publish({"type": "asset", "asset": a})
        return out

    @app.post("/api/assets/import")
    async def import_asset(body: dict = Body(...)):
        """Import from {"source": absolute path | http(s) URL | data: URI | base64}."""
        a = await import_source(str(body.get("source", "")), bool(body.get("hidden", False)), body.get("name", ""))
        if not a["hidden"]:
            bus.publish({"type": "asset", "asset": a})
        return a

    @app.get("/api/assets/{aid}")
    async def get_asset(aid: str):
        a = library.get(aid)
        if not a:
            raise HTTPException(404, "Not found")
        return a

    @app.get("/api/assets/{aid}/file")
    async def asset_file(aid: str, download: bool = False):
        a = library.get(aid)
        if not a or not Path(a["path"]).exists():
            raise HTTPException(404, "Not found")
        return FileResponse(a["path"], media_type="image/png",
                            filename=Path(a["path"]).name if download else None,
                            headers={"Cache-Control": "max-age=31536000, immutable"})

    @app.get("/api/assets/{aid}/thumb")
    async def asset_thumb(aid: str):
        p = library.thumb_path(aid)
        if not p:
            raise HTTPException(404, "Not found")
        return FileResponse(p, media_type="image/webp", headers={"Cache-Control": "max-age=31536000, immutable"})

    @app.patch("/api/assets/{aid}")
    async def patch_asset(aid: str, body: dict = Body(...)):
        a = library.update(aid, **body)
        if not a:
            raise HTTPException(404, "Not found")
        bus.publish({"type": "asset_updated", "asset": a})
        return a

    @app.delete("/api/assets/{aid}")
    async def delete_asset(aid: str):
        if not library.trash(aid):
            raise HTTPException(404, "Not found")
        bus.publish({"type": "asset_deleted", "id": aid})
        return {"ok": True}

    @app.post("/api/assets/{aid}/transform")
    async def transform(aid: str, body: dict = Body(...)):
        """Traditional rotate, flip and resize: instant pixel work that saves a new image."""
        a = library.get(aid)
        if not a:
            raise HTTPException(404, "Not found")
        try:
            img, label = imaging.transform(library.open_image(aid), rotate=int(body.get("rotate") or 0),
                                           flip=body.get("flip") or "", width=int(body.get("width") or 0),
                                           height=int(body.get("height") or 0))
        except ValueError as e:
            raise HTTPException(400, str(e))
        out = library.add_image(img, source="edited", op="transform", prompt=label, params=body, parents=[aid])
        bus.publish({"type": "asset", "asset": out})
        return out

    @app.post("/api/assets/rendered")
    async def rendered(file: UploadFile = File(...), parent: str = Form(...), params: str = Form("{}"),
                       prompt: str = Form("Adjust")):
        """Saves an image the UI rendered from `parent` (Traditional › Adjust), with the settings it used."""
        if not library.get(parent):
            raise HTTPException(400, f"Unknown image id '{parent}'")
        try:
            img = Image.open(io.BytesIO(await file.read()))
            img.load()
            settings = json.loads(params)
        except Exception as e:
            raise HTTPException(400, f"Not a readable image ({e})")
        out = library.add_image(img, source="edited", op="adjust", prompt=prompt, params=settings, parents=[parent])
        bus.publish({"type": "asset", "asset": out})
        return out

    @app.post("/api/assets/{aid}/reveal")
    async def reveal(aid: str):
        a = library.get(aid)
        if not a:
            raise HTTPException(404, "Not found")
        subprocess.Popen(["open", "-R", a["path"]])
        return {"ok": True}

    # ---------- jobs ----------

    @app.post("/api/jobs")
    async def submit(body: dict = Body(...)):
        try:
            job = queue.submit(body.get("op", ""), body.get("params") or {}, body.get("source") or "app")
        except ValueError as e:
            raise HTTPException(400, str(e))
        return job.public()

    @app.get("/api/jobs")
    async def jobs():
        return queue.list()

    @app.get("/api/jobs/{jid}")
    async def job(jid: str):
        j = queue.get(jid)
        if not j:
            raise HTTPException(404, "Not found")
        return j

    @app.get("/api/jobs/{jid}/wait")
    async def wait(jid: str, timeout: float = 60):
        j = await queue.wait(jid, max(0.0, min(timeout, 600)))
        if not j:
            raise HTTPException(404, "Not found")
        return j

    @app.post("/api/jobs/{jid}/cancel")
    async def cancel(jid: str):
        return {"ok": await queue.cancel(jid)}

    @app.post("/api/jobs/{jid}/pause")
    async def pause(jid: str):
        return {"ok": await queue.pause(jid)}

    @app.post("/api/jobs/{jid}/resume")
    async def resume(jid: str):
        return {"ok": queue.resume(jid)}

    @app.post("/api/jobs/order")
    async def reorder(body: dict = Body(...)):
        """Sets the order of the waiting jobs: {"ids": [...]}, next to run first."""
        return {"order": queue.reorder([str(i) for i in body.get("ids") or []])}

    # ---------- events ----------

    @app.websocket("/api/events")
    async def events(ws: WebSocket):
        await ws.accept()
        q = bus.subscribe()
        activity.ui_clients += 1

        async def pump() -> None:
            while True:
                event = await q.get()
                await ws.send_text(json.dumps(event))

        sender = asyncio.create_task(pump())
        try:
            await ws.send_json({"type": "hello", "active_model": engines.active, "engines": engines.statuses(),
                                "setups": {m: i.public() for m, i in installers.items()}, "jobs": queue.list()})
            # Reading is how we notice the client (or a server shutdown) closing the socket.
            while True:
                await ws.receive_text()
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            sender.cancel()
            activity.ui_clients -= 1
            activity.touch()
            bus.unsubscribe(q)

    # ---------- MCP + UI ----------

    app.router.routes.extend(mcp_app.routes)

    if WEB_DIST.exists():
        app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="web-assets")

        @app.get("/{path:path}")
        async def spa(path: str):
            f = WEB_DIST / path
            if path and f.is_file() and WEB_DIST in f.resolve().parents:
                return FileResponse(f)
            return FileResponse(WEB_DIST / "index.html", headers={"Cache-Control": "no-cache"})
    else:
        @app.get("/")
        async def no_ui():
            return JSONResponse({"error": "UI not built. Run: npm --prefix web run build"}, 503)

    return app


def _needs_setup(model: str) -> bool:
    if model == "qwen" and config.load_settings().comfy_mode != "bundled":
        return False
    inst = installers[model]
    inst.refresh()
    return inst.status.state != "ready"


async def import_source(source: str, hidden: bool = False, name: str = "") -> dict:
    source = source.strip()
    if not source:
        raise HTTPException(400, "Empty image source")
    if re.fullmatch(r"[0-9a-f]{12}", source) and library.get(source):
        return library.get(source)
    try:
        if source.startswith("data:"):
            data = base64.b64decode(source.split(",", 1)[1])
        elif source.startswith(("http://", "https://")):
            async with httpx.AsyncClient(follow_redirects=True, timeout=60) as c:
                r = await c.get(source)
                r.raise_for_status()
                data = r.content
            name = name or source.rsplit("/", 1)[-1][:80]
        elif source.startswith(("/", "~", "file://")):
            p = Path(source.removeprefix("file://")).expanduser()
            if not p.is_file():
                raise HTTPException(400, f"No file at {p}")
            data = p.read_bytes()
            name = name or p.name
        else:
            data = base64.b64decode(source, validate=True)
        return library.import_bytes(data, name, hidden)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"Could not read image from source: {e}")


async def _idle_watch(idle_exit: float) -> None:
    import os
    import signal

    while True:
        await asyncio.sleep(30)
        if activity.ui_clients == 0 and queue.pending() == 0 and time.time() - activity.last > idle_exit:
            log.info("Idle for %ss, shutting down", idle_exit)
            os.kill(os.getpid(), signal.SIGTERM)
            return
