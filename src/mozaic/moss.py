"""MOSS-Image engine: a long-lived worker process (moss_worker.py) in the MOSS engine's Python."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import uuid
from pathlib import Path
from typing import Any, Callable

from . import config, installer
from .comfy import ComfyError, Interrupted

log = logging.getLogger("mozaic.moss")

WORKER = Path(__file__).parent / "moss_worker.py"


class MossEngine:
    model = "moss"

    def __init__(self) -> None:
        self.state = "stopped"  # stopped | setup | starting | ready | error
        self.detail = ""
        self.proc: asyncio.subprocess.Process | None = None
        self.listeners: list[Callable[[dict], Any]] = []
        self._reader: asyncio.Task | None = None
        self._jobs: dict[str, asyncio.Queue] = {}
        self._ready = asyncio.Event()
        self._lock = asyncio.Lock()

    def status(self) -> dict:
        return {"model": self.model, "state": self.state, "detail": self.detail, "mode": "moss",
                "url": "", "managed_pid": self.proc.pid if self.proc and self.proc.returncode is None else None}

    def _set_state(self, state: str, detail: str = "") -> None:
        self.state, self.detail = state, detail
        for fn in list(self.listeners):
            try:
                fn({"type": "engine", "model": self.model, "engine": self.status()})
            except Exception:
                log.exception("listener failed")

    async def start(self) -> None:
        async with self._lock:
            if self.proc and self.proc.returncode is None and self.state == "ready":
                return
            if not installer.installers["moss"].ready():
                self._set_state("setup", "MOSS-Image is still setting up")
                return
            self._set_state("starting", "Starting MOSS engine")
            self._ready = asyncio.Event()
            log_file = open(config.LOG_DIR / "moss.log", "ab")
            env = dict(os.environ, PYTHONUNBUFFERED="1")
            self.proc = await asyncio.create_subprocess_exec(
                str(installer.MOSS_VENV / "bin" / "python"), "-u", str(WORKER),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=log_file,
                env=env, cwd=str(config.APP_SUPPORT), start_new_session=True, limit=16 * 1024 * 1024)
            self._reader = asyncio.create_task(self._read())
            try:
                await asyncio.wait_for(self._ready.wait(), 120)
            except asyncio.TimeoutError:
                self._set_state("error", f"MOSS engine did not start. See {config.LOG_DIR / 'moss.log'}")
                return
            self._set_state("ready", "")

    async def _read(self) -> None:
        proc = self.proc
        assert proc and proc.stdout
        async for raw in proc.stdout:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("type") == "ready":
                self._ready.set()
            elif msg.get("id") in self._jobs:
                self._jobs[msg["id"]].put_nowait(msg)
        code = await proc.wait()
        if self.proc is not proc:  # stopped on purpose, or replaced by a newer worker
            return
        for q in self._jobs.values():
            q.put_nowait({"type": "error", "error": f"MOSS engine exited (code {code}). See {config.LOG_DIR / 'moss.log'}"})
        if self.state != "stopped":
            self._set_state("stopped" if code in (0, -signal.SIGTERM) else "error",
                            "" if code in (0, -signal.SIGTERM) else f"MOSS engine exited (code {code})")

    async def stop(self) -> None:
        proc = self.proc
        self.state = "stopped"
        if proc and proc.returncode is None:
            try:
                proc.stdin.close()
            except Exception:
                pass
            try:
                await asyncio.wait_for(proc.wait(), 10)
            except asyncio.TimeoutError:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        self.proc = None
        self._set_state("stopped", "")

    def stop_sync(self) -> None:
        if self.proc and self.proc.returncode is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
            except Exception:
                pass

    async def ensure_ready(self) -> None:
        inst = installer.installers["moss"]
        if not inst.ready():
            if inst.status.state != "running":
                raise ComfyError("MOSS-Image isn't installed yet. Open Mozaic and pick MOSS-Image to set it up.")
            await inst.wait()
        if self.state != "ready" or not self.proc or self.proc.returncode is not None:
            await self.start()
        if self.state != "ready":
            raise ComfyError(self.detail or "The MOSS engine is not available")

    async def run(self, cfg: dict, request: dict, output: Path,
                  on_event: Callable[[dict], Any] | None = None, job_ref: dict | None = None) -> dict:
        await self.ensure_ready()
        jid = uuid.uuid4().hex
        q: asyncio.Queue = asyncio.Queue()
        self._jobs[jid] = q
        if job_ref is not None:
            job_ref["moss_id"] = jid
        try:
            self._send({"cmd": "generate", "id": jid, "config": cfg, "request": request, "output": str(output)})
            while True:
                msg = await q.get()
                t = msg["type"]
                if t == "done":
                    return msg
                if t == "error":
                    log.error("MOSS job failed: %s", msg.get("trace", msg["error"]))
                    raise ComfyError(msg["error"])
                if t == "cancelled":
                    raise Interrupted("Cancelled")
                if on_event:
                    r = on_event(msg)
                    if asyncio.iscoroutine(r):
                        await r
        finally:
            self._jobs.pop(jid, None)

    def cancel(self, moss_id: str) -> None:
        self._send({"cmd": "cancel", "id": moss_id})

    def _send(self, msg: dict) -> None:
        if not self.proc or self.proc.returncode is not None or not self.proc.stdin:
            raise ComfyError("The MOSS engine is not running")
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())


moss_engine = MossEngine()


class Engines:
    """Keeps only the active model's engine loaded."""

    def __init__(self) -> None:
        from .comfy import engine as comfy_engine

        self.by_model = {"qwen": comfy_engine, "moss": moss_engine}
        self._switch_lock = asyncio.Lock()
        self.listeners: list[Callable[[dict], Any]] = []

    @property
    def active(self) -> str:
        m = config.load_settings().active_model
        return m if m in self.by_model else "qwen"

    def get(self, model: str):
        return self.by_model[model]

    def statuses(self) -> dict:
        return {m: e.status() for m, e in self.by_model.items()}

    async def use(self, model: str, start: bool = True) -> None:
        """Makes `model` the active one: stops the other engine (freeing its memory) and starts this one."""
        if model not in self.by_model:
            raise ValueError(f"Unknown model '{model}'")
        async with self._switch_lock:
            if self.active != model:
                config.save_settings({"active_model": model})
                for fn in list(self.listeners):
                    fn({"type": "active_model", "model": model})
            for m, e in self.by_model.items():
                if m != model and e.state in ("ready", "starting"):
                    await e.stop()
            if start:
                inst = installer.installers[model]
                if not inst.ready():
                    inst.start()
                else:
                    asyncio.create_task(self.by_model[model].start())


engines = Engines()
