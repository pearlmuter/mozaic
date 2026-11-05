"""Runs ComfyUI headless (or connects to one) and talks to its HTTP + websocket API."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import struct
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import httpx
import websockets

from . import config, installer

log = logging.getLogger("mozaic.comfy")

MODEL_FOLDERS = [
    "checkpoints", "classifiers", "clip_vision", "configs", "diffusers", "diffusion_models", "embeddings",
    "gligen", "hypernetworks", "latent_upscale_models", "loras", "model_patches", "audio_encoders",
    "photomaker", "style_models", "text_encoders", "upscale_models", "background_removal", "vae",
    "vae_approx", "clip", "unet",
]


class ComfyError(RuntimeError):
    pass


class Interrupted(ComfyError):
    pass


@dataclass
class PromptWatch:
    prompt_id: str
    events: asyncio.Queue = field(default_factory=asyncio.Queue)


class ComfyEngine:
    """Owns the ComfyUI process (in managed mode) and a single websocket connection."""

    def __init__(self) -> None:
        self.state = "stopped"  # stopped | setup | starting | ready | error
        self.detail = ""
        self.proc: subprocess.Popen | None = None
        self.client_id = uuid.uuid4().hex
        self.http: httpx.AsyncClient | None = None
        self._ws_task: asyncio.Task | None = None
        self._watches: dict[str, PromptWatch] = {}
        self._current_prompt: str | None = None
        self._start_lock = asyncio.Lock()
        self._object_info: dict[str, Any] | None = None
        self.listeners: list[Callable[[dict], Any]] = []
        self.started_at = 0.0

    # ---------- lifecycle ----------

    @property
    def url(self) -> str:
        return config.load_settings().resolved_comfy_url()

    def status(self) -> dict:
        s = config.load_settings()
        return {
            "model": "qwen",
            "state": self.state,
            "detail": self.detail,
            "mode": s.comfy_mode,
            "url": self.url,
            "managed_pid": self.proc.pid if self.proc and self.proc.poll() is None else None,
        }

    def _emit(self, event: dict) -> None:
        for fn in list(self.listeners):
            try:
                fn(event)
            except Exception:
                log.exception("listener failed")

    def _set_state(self, state: str, detail: str = "") -> None:
        self.state, self.detail = state, detail
        self._emit({"type": "engine", "model": "qwen", "engine": self.status()})

    async def _client(self) -> httpx.AsyncClient:
        if self.http is None:
            self.http = httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=5.0))
        return self.http

    async def ping(self) -> bool:
        try:
            r = await (await self._client()).get(f"{self.url}/system_stats", timeout=3)
            return r.status_code == 200 and "system" in r.json()
        except Exception:
            return False

    def _python(self, comfy_dir: Path) -> Path:
        for p in (comfy_dir / ".venv" / "bin" / "python", comfy_dir.parent / "standalone-env" / "bin" / "python3"):
            if p.exists():
                return p
        raise ComfyError(f"No Python environment found next to {comfy_dir}")

    def _install(self) -> tuple[Path, Path]:
        """The ComfyUI folder and Python to run, for the bundled or a custom install."""
        s = config.load_settings()
        if s.comfy_mode == "bundled":
            return installer.COMFY_DIR, installer.ENGINE_VENV / "bin" / "python"
        comfy_dir = Path(s.comfy_path)
        if not (comfy_dir / "main.py").exists():
            raise ComfyError("ComfyUI install not found. Set its folder in Settings.")
        return comfy_dir, self._python(comfy_dir)

    def _write_model_paths(self) -> Path:
        s = config.load_settings()
        dirs = [str(installer.MODELS_DIR)] + [d for d in s.models_dirs if d != str(installer.MODELS_DIR)]
        lines = ["# Written by Mozaic. Points ComfyUI at Mozaic's model folders."]
        for i, base in enumerate(dirs):
            lines.append(f"mozaic_{i}:")
            lines.append(f"  base_path: '{base}'")
            if i == 0:
                lines.append("  is_default: true")
            for folder in MODEL_FOLDERS:
                lines.append(f"  '{folder}': '{folder}/'")
        path = config.COMFY_STATE_DIR / "extra_model_paths.yaml"
        path.write_text("\n".join(lines) + "\n")
        return path

    async def start(self) -> None:
        async with self._start_lock:
            if self.state == "ready" and await self.ping():
                return
            s = config.load_settings()
            self._set_state("starting", "Connecting to ComfyUI" if s.comfy_mode == "external" else "Starting Qwen Image 2.1")
            if await self.ping():
                await self._on_ready()
                return
            if s.comfy_mode == "external":
                self._set_state("error", f"Can't reach ComfyUI at {self.url}")
                return
            if s.comfy_mode == "bundled" and not installer.ready():
                self._set_state("setup", "Mozaic is still setting up")
                return
            try:
                comfy_dir, python = self._install()
            except ComfyError as e:
                self._set_state("error", str(e))
                return
            state = config.COMFY_STATE_DIR
            for sub in ("input", "output", "temp", "user"):
                (state / sub).mkdir(parents=True, exist_ok=True)
            args = [
                str(python), "main.py",
                "--listen", "127.0.0.1", "--port", str(s.comfy_port),
                "--extra-model-paths-config", str(self._write_model_paths()),
                "--input-directory", str(state / "input"),
                "--output-directory", str(state / "output"),
                "--temp-directory", str(state / "temp"),
                "--user-directory", str(state / "user"),
                "--database-url", f"sqlite:///{state / 'comfyui.db'}",
                "--preview-method", "auto",
                "--preview-size", "768",
                "--disable-auto-launch",
            ]
            env = dict(os.environ, PYTORCH_ENABLE_MPS_FALLBACK="1", PYTHONUNBUFFERED="1")
            log_file = open(config.LOG_DIR / "comfyui.log", "ab")
            self._set_state("starting", "Starting Qwen Image 2.1")
            proc = self.proc = subprocess.Popen(args, cwd=comfy_dir, env=env, stdout=log_file,
                                                stderr=subprocess.STDOUT, start_new_session=True)
            self.started_at = time.time()
            deadline = time.time() + 300
            while time.time() < deadline:
                if self.proc is not proc:  # stopped while starting (e.g. switched to another model)
                    return
                if proc.poll() is not None:
                    self._set_state("error", f"ComfyUI exited (code {proc.returncode}). See {config.LOG_DIR / 'comfyui.log'}")
                    return
                if await self.ping():
                    await self._on_ready()
                    return
                await asyncio.sleep(1)
            self._set_state("error", "ComfyUI did not start within 5 minutes")

    async def _on_ready(self) -> None:
        self._object_info = None
        if self._ws_task is None or self._ws_task.done():
            self._ws_task = asyncio.create_task(self._ws_loop())
        self._set_state("ready", "")

    async def stop(self) -> None:
        if self._ws_task:
            self._ws_task.cancel()
            self._ws_task = None
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            for _ in range(50):
                if self.proc.poll() is not None:
                    break
                await asyncio.sleep(0.2)
            if self.proc.poll() is None:
                os.killpg(self.proc.pid, signal.SIGKILL)
        self.proc = None
        self._set_state("stopped", "")

    def stop_sync(self) -> None:
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
                self.proc.wait(timeout=10)
            except Exception:
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except Exception:
                    pass

    async def ensure_ready(self) -> None:
        if config.load_settings().comfy_mode == "bundled" and not installer.ready():
            if installer.installer.status.state != "running":
                raise ComfyError("Mozaic hasn't finished setting up. Open the Mozaic app to install the engine and models.")
            await installer.installer.wait()
        if self.state != "ready" or not await self.ping():
            await self.start()
        if self.state != "ready":
            raise ComfyError(self.detail or "ComfyUI is not available")

    # ---------- websocket ----------

    async def _ws_loop(self) -> None:
        ws_url = self.url.replace("http", "ws", 1) + f"/ws?clientId={self.client_id}"
        while True:
            try:
                async with websockets.connect(ws_url, max_size=64 * 1024 * 1024) as ws:
                    async for msg in ws:
                        if isinstance(msg, bytes):
                            self._on_binary(msg)
                        else:
                            self._on_message(json.loads(msg))
            except asyncio.CancelledError:
                return
            except Exception as e:
                log.debug("websocket dropped: %s", e)
                if not await self.ping():
                    self._set_state("error" if config.load_settings().comfy_mode == "external" else "stopped",
                                    "ComfyUI stopped responding")
                    for w in self._watches.values():
                        w.events.put_nowait({"type": "execution_error", "data": {"exception_message": "ComfyUI stopped"}})
                    return
                await asyncio.sleep(1)

    def _on_message(self, msg: dict) -> None:
        mtype, data = msg.get("type"), msg.get("data") or {}
        pid = data.get("prompt_id")
        if mtype == "execution_start":
            self._current_prompt = pid
        elif mtype == "executing" and data.get("node") is None and pid == self._current_prompt:
            self._current_prompt = None
        if pid and pid in self._watches:
            self._watches[pid].events.put_nowait(msg)

    def _on_binary(self, buf: bytes) -> None:
        if len(buf) < 8:
            return
        event = struct.unpack(">I", buf[:4])[0]
        pid = self._current_prompt
        if event == 1:
            image = buf[8:]
        elif event == 4:
            mlen = struct.unpack(">I", buf[4:8])[0]
            meta = json.loads(buf[8:8 + mlen] or b"{}")
            pid = meta.get("prompt_id") or pid
            image = buf[8 + mlen:]
        else:
            return
        if pid and pid in self._watches:
            self._watches[pid].events.put_nowait({"type": "preview", "data": {"image": image}})

    # ---------- API ----------

    async def object_info(self) -> dict:
        if self._object_info is None:
            r = await (await self._client()).get(f"{self.url}/object_info", timeout=60)
            r.raise_for_status()
            self._object_info = r.json()
        return self._object_info

    async def choices(self, node: str, input_name: str) -> list:
        info = (await self.object_info()).get(node, {})
        spec = {**info.get("input", {}).get("required", {}), **info.get("input", {}).get("optional", {})}.get(input_name)
        if not spec:
            return []
        if isinstance(spec[0], list):
            return spec[0]
        if spec[0] == "COMBO" and len(spec) > 1:
            return spec[1].get("options", [])
        return []

    def invalidate_object_info(self) -> None:
        self._object_info = None

    async def upload_image(self, data: bytes, name: str) -> str:
        files = {"image": (name, data, "image/png")}
        r = await (await self._client()).post(f"{self.url}/upload/image", files=files,
                                              data={"type": "input", "overwrite": "true"})
        r.raise_for_status()
        j = r.json()
        return f"{j['subfolder']}/{j['name']}" if j.get("subfolder") else j["name"]

    async def fetch_output(self, filename: str, subfolder: str, kind: str) -> bytes:
        r = await (await self._client()).get(f"{self.url}/view",
                                             params={"filename": filename, "subfolder": subfolder, "type": kind})
        r.raise_for_status()
        return r.content

    async def interrupt(self, prompt_id: str) -> None:
        c = await self._client()
        try:
            await c.post(f"{self.url}/queue", json={"delete": [prompt_id]})
            await c.post(f"{self.url}/interrupt", json={"prompt_id": prompt_id})
        except Exception:
            log.exception("interrupt failed")

    async def run(self, graph: dict, on_event: Callable[[dict], Any] | None = None) -> dict:
        """Queue a graph and wait for it. Returns ComfyUI's history entry outputs."""
        await self.ensure_ready()
        c = await self._client()
        r = await c.post(f"{self.url}/prompt", json={"prompt": graph, "client_id": self.client_id})
        if r.status_code != 200:
            try:
                err = r.json()
                detail = err.get("error", {}).get("message", "")
                nodes = err.get("node_errors", {})
                parts = [f"{n.get('class_type')}: {e.get('message', '')} {e.get('details', '')}"
                         for n in nodes.values() for e in n.get("errors", [])]
                if parts:
                    detail += " " + "; ".join(parts)
            except Exception:
                detail = r.text
            raise ComfyError(f"ComfyUI rejected the workflow: {detail.strip()}")
        prompt_id = r.json()["prompt_id"]
        watch = PromptWatch(prompt_id)
        self._watches[prompt_id] = watch
        if on_event:
            await _maybe_await(on_event({"type": "queued", "data": {"prompt_id": prompt_id}}))
        try:
            while True:
                try:
                    msg = await asyncio.wait_for(watch.events.get(), timeout=3)
                except asyncio.TimeoutError:
                    entry = await self._history(prompt_id)
                    if entry and entry.get("status", {}).get("completed"):
                        return entry.get("outputs", {})
                    if entry and entry.get("status", {}).get("status_str") == "error":
                        raise ComfyError(_history_error(entry))
                    continue
                mtype, data = msg["type"], msg.get("data", {})
                if on_event:
                    await _maybe_await(on_event(msg))
                if mtype == "execution_success":
                    break
                if mtype == "execution_error":
                    raise ComfyError(f"{data.get('node_type', '')}: {data.get('exception_message', 'failed')}".strip(": "))
                if mtype == "execution_interrupted":
                    raise Interrupted("Cancelled")
            entry = await self._history(prompt_id)
            return (entry or {}).get("outputs", {})
        finally:
            self._watches.pop(prompt_id, None)

    async def _history(self, prompt_id: str) -> dict | None:
        try:
            r = await (await self._client()).get(f"{self.url}/history/{prompt_id}", timeout=10)
            return r.json().get(prompt_id)
        except Exception:
            return None

    async def free_memory(self) -> None:
        await (await self._client()).post(f"{self.url}/free", json={"unload_models": True, "free_memory": True})


def _history_error(entry: dict) -> str:
    for m in entry.get("status", {}).get("messages", []):
        if m[0] == "execution_error":
            return m[1].get("exception_message", "failed")
    return "failed"


async def _maybe_await(x):
    if asyncio.iscoroutine(x):
        await x


engine = ComfyEngine()
