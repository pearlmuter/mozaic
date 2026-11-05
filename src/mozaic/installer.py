"""First-run setup: installs each model's engine and fetches its weights.

Everything lands in ~/Library/Application Support/Mozaic, so Mozaic doesn't depend on any other
install. Two models, each with its own installer:

- Qwen Image 2.1 runs on Mozaic's own ComfyUI (Python + PyTorch). Model files that already exist
  elsewhere on the disk (for example from Comfy Desktop) are hard-linked instead of downloaded: no
  extra space, and they survive the other app being uninstalled.
- MOSS-Image runs on MLX through moss-image-mlx, in its own Python environment.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import platform
import shutil
import tarfile
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable

import httpx

from . import config

log = logging.getLogger("mozaic.installer")

ENGINE_FILES = Path(__file__).parent / "engine"
MODELS_DIR = config.APP_SUPPORT / "models"
RUNTIME_DIR = config.APP_SUPPORT / "runtime"

# Qwen Image 2.1: ComfyUI
COMFY_VERSION = "v0.37.4"
COMFY_URL = f"https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/{COMFY_VERSION}.tar.gz"
PYTHON_VERSION = "3.13"
ENGINE_DIR = config.APP_SUPPORT / "engine"
COMFY_DIR = ENGINE_DIR / "ComfyUI"
ENGINE_VENV = ENGINE_DIR / "venv"

# MOSS-Image: MLX
MOSS_PACKAGE = "moss-image-mlx==0.2.0"
MOSS_ENGINE_DIR = config.APP_SUPPORT / "moss-engine"
MOSS_VENV = MOSS_ENGINE_DIR / "venv"
MOSS_DIR = MODELS_DIR / "moss"
MOSS_SFT = MOSS_DIR / "MOSS-Image-SFT-MLX-8bit"
MOSS_BASE_TRANSFORMER = MOSS_DIR / "MOSS-Image-Base-MLX-8bit" / "transformer"
MOSS_TURBO_STUDENT = MOSS_DIR / "turbo" / "turbo_student.safetensors"
MOSS_TURBO_DESTRIPE = MOSS_DIR / "turbo" / "moss_sft_destripe_top64_bf16.safetensors"

MIN_RAM_GB = 32


@dataclass(frozen=True)
class ModelFile:
    rel: str  # path under MODELS_DIR
    url: str
    size: int
    sha256: str
    label: str
    reuse: tuple[str, ...] = ()  # model subfolders to look in for an existing copy (by file name)

    @property
    def path(self) -> Path:
        return MODELS_DIR / self.rel

    @property
    def name(self) -> str:
        return self.rel.rsplit("/", 1)[-1]


QWEN_HF = "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main"
QWEN_FILES = [
    ModelFile("diffusion_models/qwen_image_2.1_int8_convrot.safetensors",
              f"{QWEN_HF}/diffusion_models/qwen_image_2.1_int8_convrot.safetensors", 7_256_783_064,
              "cb74113cb03faecd79611b01fd7fd642f0aa60d6f0b95086abee214d75eaa57d", "Image model",
              ("diffusion_models", "unet")),
    ModelFile("text_encoders/qwen3vl_8b_int8_convrot.safetensors",
              f"{QWEN_HF}/text_encoders/qwen3vl_8b_int8_convrot.safetensors", 9_350_798_360,
              "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f", "Text encoder (Qwen3-VL 8B)",
              ("text_encoders", "clip")),
    ModelFile("vae/qwen_image_2.1_vae_bf16.safetensors",
              f"{QWEN_HF}/vae/qwen_image_2.1_vae_bf16.safetensors", 675_509_688,
              "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9", "VAE", ("vae",)),
]

MOSS_FILES = [ModelFile(f["rel"], f["url"], f["size"], f["sha256"], f["label"])
              for f in json.loads((ENGINE_FILES / "moss_manifest.json").read_text())]


def _stamp(*parts: str | bytes) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(p if isinstance(p, bytes) else p.encode())
    return h.hexdigest()[:16]


def _stamp_ok(path: Path, stamp: str) -> bool:
    try:
        return json.loads(path.read_text()).get("stamp") == stamp
    except Exception:
        return False


def find_uv() -> str | None:
    for candidate in (os.environ.get("MOZAIC_UV"), str(RUNTIME_DIR / "uv"), shutil.which("uv"),
                      "/opt/homebrew/bin/uv", "/usr/local/bin/uv"):
        if candidate and Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return candidate
    return None


def _uv_env() -> dict:
    env = dict(
        os.environ,
        UV_PYTHON_INSTALL_DIR=str(config.APP_SUPPORT / "python"),
        UV_CACHE_DIR=str(config.APP_SUPPORT / "cache" / "uv"),
        UV_PYTHON_PREFERENCE="only-managed",
        UV_NO_PROGRESS="1",
    )
    env.pop("UV_PROJECT_ENVIRONMENT", None)
    env.pop("VIRTUAL_ENV", None)
    return env


def _ram_gb() -> float:
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024**3
    except Exception:
        return 0.0


def _search_dirs() -> list[Path]:
    """Folders where Qwen model files may already exist (Comfy Desktop, plain ComfyUI installs)."""
    dirs: list[Path] = []
    try:
        data = json.loads((config.COMFY_DESKTOP_DIR / "settings.json").read_text())
        dirs += [Path(d) for d in data.get("modelsDirs", [])]
    except Exception:
        pass
    try:
        for inst in json.loads((config.COMFY_DESKTOP_DIR / "installations.json").read_text()):
            dirs.append(Path(inst["installPath"]) / "ComfyUI" / "models")
    except Exception:
        pass
    home = Path.home()
    dirs += [home / "ComfyUI-Shared" / "models", home / "ComfyUI" / "models", home / "Documents" / "ComfyUI" / "models"]
    dirs += [Path(d) for d in config.load_settings().models_dirs]
    seen, out = set(), []
    for d in dirs:
        if d.is_dir() and d.resolve() != MODELS_DIR.resolve() and d not in seen:
            seen.add(d)
            out.append(d)
    return out


def find_existing(m: ModelFile) -> Path | None:
    if not m.reuse:
        return None
    for d in _search_dirs():
        for sub in m.reuse:
            p = d / sub / m.name
            if p.is_file() and p.stat().st_size == m.size:
                return p
    return None


@dataclass
class FileProgress:
    label: str
    name: str
    size: int
    done: int = 0
    state: str = "pending"  # pending | linking | copying | downloading | done
    source: str = ""


@dataclass
class SetupStatus:
    model: str = ""
    title: str = ""
    engine_label: str = ""
    engine_size: int = 0
    state: str = "idle"  # idle | running | ready | error
    step: str = ""  # engine | models
    detail: str = ""
    error: str | None = None
    engine_ready: bool = False
    engine_progress: float = 0.0
    models_ready: bool = False
    files: list[FileProgress] = field(default_factory=list)
    downloaded: int = 0
    to_download: int = 0
    speed: float = 0.0
    disk_free: int = 0
    disk_needed: int = 0
    ram_gb: float = 0.0
    warnings: list[str] = field(default_factory=list)


class Installer:
    """Installs one model's engine and fetches its files. Subclasses define what that means."""

    model = ""
    title = ""
    engine_label = ""
    engine_bytes = 0
    files: list[ModelFile] = []

    def __init__(self) -> None:
        self.status = SetupStatus(model=self.model, title=self.title, engine_label=self.engine_label,
                                  engine_size=self.engine_bytes)
        self.task: asyncio.Task | None = None
        self.listeners: list[Callable[[dict], None]] = []
        self._last_emit = 0.0
        self._finished_bytes = 0
        self.on_ready: Callable[[], None] | None = None
        self.refresh()

    # ---------- per-model hooks ----------

    def engine_ready(self) -> bool:
        raise NotImplementedError

    async def install_engine(self, uv: str) -> None:
        raise NotImplementedError

    # ---------- state ----------

    def models_ready(self) -> bool:
        return all(m.path.exists() and m.path.stat().st_size == m.size for m in self.files)

    def ready(self) -> bool:
        return self.engine_ready() and self.models_ready()

    def refresh(self) -> None:
        s = self.status
        s.engine_ready = self.engine_ready()
        s.models_ready = self.models_ready()
        s.ram_gb = round(_ram_gb(), 1)
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        s.disk_free = shutil.disk_usage(MODELS_DIR).free
        if not s.files:
            s.files = [FileProgress(m.label, m.name, m.size) for m in self.files]
        for m, f in zip(self.files, s.files):
            if m.path.exists() and m.path.stat().st_size == m.size:
                f.state, f.done = "done", m.size
            elif f.state == "pending":
                existing = find_existing(m)
                f.source = str(existing) if existing else ""
        missing = [f for f in s.files if f.state != "done" and not f.source]
        s.to_download = sum(f.size for f in missing)
        s.disk_needed = s.to_download + (0 if s.engine_ready else self.engine_bytes)
        s.warnings = []
        if platform.machine() != "arm64":
            s.warnings.append("Mozaic needs a Mac with Apple Silicon (M1 or later).")
        if s.ram_gb and s.ram_gb < MIN_RAM_GB:
            s.warnings.append(f"This Mac has {s.ram_gb:.0f} GB of memory. {self.title} needs about 20 GB free, "
                              "so expect it to be slow or fail.")
        if s.state not in ("running", "error"):
            s.state = "ready" if s.engine_ready and s.models_ready else "idle"

    def public(self) -> dict:
        return asdict(self.status)

    def _emit(self, force: bool = False) -> None:
        now = time.time()
        if not force and now - self._last_emit < 0.4:
            return
        self._last_emit = now
        event = {"type": "setup", "model": self.model, "setup": self.public()}
        for fn in list(self.listeners):
            try:
                fn(event)
            except Exception:
                log.exception("setup listener failed")

    # ---------- run ----------

    def start(self) -> None:
        if self.task and not self.task.done():
            return
        self.status.error = None
        self.task = asyncio.create_task(self._run())

    async def wait(self) -> None:
        if self.task:
            await asyncio.shield(self.task)

    async def cancel(self) -> None:
        if self.task and not self.task.done():
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):
                pass
        self.status.state = "idle"
        self.status.detail = "Paused"
        self._emit(True)

    async def _run(self) -> None:
        s = self.status
        s.state = "running"
        self.refresh()
        s.state = "running"
        self._emit(True)
        try:
            if platform.machine() != "arm64":
                raise RuntimeError("Mozaic needs a Mac with Apple Silicon (M1 or later).")
            if s.disk_needed > s.disk_free - 1_000_000_000:
                raise RuntimeError(
                    f"Not enough disk space: setup needs {s.disk_needed / 1e9:.1f} GB and "
                    f"{s.disk_free / 1e9:.1f} GB is free. Free up some space and try again.")
            if not self.engine_ready():
                s.step = "engine"
                uv = find_uv()
                if not uv:
                    raise RuntimeError("The bundled installer (uv) is missing. Reinstall Mozaic.")
                await self.install_engine(uv)
            s.engine_ready = True
            s.engine_progress = 1.0
            await self._fetch_models()
            s.models_ready = self.models_ready()
            s.state, s.step, s.detail = "ready", "", "Ready"
            self._emit(True)
            if self.on_ready:
                self.on_ready()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.exception("setup failed")
            s.state, s.error = "error", str(e) or e.__class__.__name__
            self._emit(True)

    # ---------- shared steps ----------

    def _engine_step(self, progress: float, detail: str) -> None:
        self.status.engine_progress = progress
        self.status.detail = detail
        self._emit(True)

    async def _uv(self, uv: str, args: list[str], start: float, end: float, cwd: Path | None = None) -> None:
        proc = await asyncio.create_subprocess_exec(
            uv, *args, env=_uv_env(), cwd=cwd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        tail: list[str] = []
        seen = 0
        logfile = open(config.LOG_DIR / "setup.log", "a")
        assert proc.stdout
        try:
            async for raw in proc.stdout:
                line = raw.decode(errors="replace").strip()
                logfile.write(line + "\n")
                if not line:
                    continue
                tail = (tail + [line])[-15:]
                seen += 1
                # uv prints a line per downloaded/installed package; use that as a rough progress signal.
                self.status.engine_progress = min(end, start + (end - start) * (1 - 1 / (1 + seen / 25)))
                if line.startswith(("Downloading", "Downloaded", "Installed", "Prepared", "Resolved", "Using")):
                    self.status.detail = line[:120]
                self._emit()
            code = await proc.wait()
        except asyncio.CancelledError:
            proc.kill()
            await proc.wait()
            raise
        finally:
            logfile.close()
        if code != 0:
            raise RuntimeError("Installing the engine failed:\n" + "\n".join(tail[-6:]))

    async def _fetch_models(self) -> None:
        s = self.status
        s.step = "models"
        self._finished_bytes = 0
        for m, f in zip(self.files, s.files):
            if m.path.exists() and m.path.stat().st_size == m.size:
                f.state, f.done = "done", m.size
                continue
            m.path.parent.mkdir(parents=True, exist_ok=True)
            existing = find_existing(m)
            if existing:
                f.source = str(existing)
                try:
                    f.state = "linking"
                    s.detail = f"Reusing {m.label} from {existing.parent.parent}"
                    self._emit(True)
                    os.link(existing, m.path)
                except OSError:
                    f.state = "copying"
                    s.detail = f"Copying {m.label} from {existing.parent.parent}"
                    await self._copy(existing, m.path, f)
                f.state, f.done = "done", m.size
                self._emit(True)
                continue
            f.state = "downloading"
            s.detail = f"Downloading {m.label}"
            await self._download(m.url, m.path, f, m)
            f.state, f.done = "done", m.size
            self._finished_bytes += m.size
            self._emit(True)

    async def _copy(self, src: Path, dest: Path, f: FileProgress) -> None:
        tmp = dest.with_suffix(dest.suffix + ".part")

        def run() -> None:
            with open(src, "rb") as a, open(tmp, "wb") as b:
                while chunk := a.read(16 * 1024 * 1024):
                    b.write(chunk)
                    f.done += len(chunk)

        task = asyncio.create_task(asyncio.to_thread(run))
        while not task.done():
            self._emit()
            await asyncio.sleep(0.5)
        await task
        tmp.rename(dest)

    async def _download(self, url: str, dest: Path, f: FileProgress | None = None, m: ModelFile | None = None) -> None:
        """Resumable download to dest (via dest.part), verified against the model's sha256."""
        s = self.status
        part = dest.with_name(dest.name + ".part")
        hasher = hashlib.sha256() if m and m.sha256 else None
        have = part.stat().st_size if part.exists() else 0
        if hasher and have:
            s.detail = f"Checking the partial download of {m.label}"
            self._emit(True)
            await asyncio.to_thread(_hash_file, part, hasher)
        attempts = 0
        while True:
            headers = {"Range": f"bytes={have}-"} if have else {}
            try:
                async with httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(60, connect=20)) as c:
                    async with c.stream("GET", url, headers=headers) as r:
                        if r.status_code == 416 and m and have == m.size:
                            break
                        if r.status_code not in (200, 206):
                            raise RuntimeError(f"Download failed ({r.status_code}) for {url}")
                        if r.status_code == 200 and have:
                            have = 0
                            hasher = hashlib.sha256() if hasher else None
                        mode = "ab" if have else "wb"
                        window_start, window_bytes = time.time(), 0
                        with open(part, mode) as out:
                            async for chunk in r.aiter_bytes(4 * 1024 * 1024):
                                out.write(chunk)
                                if hasher:
                                    hasher.update(chunk)
                                have += len(chunk)
                                window_bytes += len(chunk)
                                if f:
                                    f.done = have
                                    s.downloaded = self._finished_bytes + have
                                    elapsed = time.time() - window_start
                                    if elapsed > 2:
                                        s.speed = window_bytes / elapsed
                                        window_start, window_bytes = time.time(), 0
                                    self._emit()
                break
            except (httpx.TransportError, httpx.StreamError) as e:
                attempts += 1
                if attempts > 8:
                    raise RuntimeError(f"Download keeps failing ({e}). Check your internet connection and retry.")
                s.detail = f"Connection lost, retrying ({attempts})…"
                self._emit(True)
                await asyncio.sleep(min(30, 2 ** attempts))
                have = part.stat().st_size if part.exists() else 0
                if hasher is not None:
                    hasher = hashlib.sha256()
                    await asyncio.to_thread(_hash_file, part, hasher)
        if m:
            if have != m.size:
                raise RuntimeError(f"{m.label} download is incomplete ({have} of {m.size} bytes). Retry to resume.")
            if hasher and hasher.hexdigest() != m.sha256:
                part.unlink(missing_ok=True)
                raise RuntimeError(f"{m.label} failed its checksum and was deleted. Retry to download it again.")
        part.rename(dest)


class QwenInstaller(Installer):
    model = "qwen"
    title = "Qwen Image 2.1"
    engine_label = "Python, PyTorch and ComfyUI"
    engine_bytes = 2_000_000_000
    files = QWEN_FILES
    stamp_file = ENGINE_DIR / "installed.json"

    @staticmethod
    def stamp() -> str:
        """Changes whenever the pinned engine changes, so an app update can reinstall it."""
        return _stamp(COMFY_VERSION, *((ENGINE_FILES / f).read_bytes() for f in ("requirements.txt", "constraints.txt")))

    def engine_ready(self) -> bool:
        return (_stamp_ok(self.stamp_file, self.stamp()) and (COMFY_DIR / "main.py").exists()
                and (ENGINE_VENV / "bin" / "python").exists())

    async def install_engine(self, uv: str) -> None:
        ENGINE_DIR.mkdir(parents=True, exist_ok=True)
        self._engine_step(0.02, f"Downloading ComfyUI {COMFY_VERSION}")
        archive = ENGINE_DIR / "comfyui.tar.gz"
        await self._download(COMFY_URL, archive)
        self._engine_step(0.08, "Unpacking ComfyUI")
        staging = ENGINE_DIR / "ComfyUI.new"
        shutil.rmtree(staging, ignore_errors=True)
        await asyncio.to_thread(_extract_root, archive, staging)
        archive.unlink(missing_ok=True)
        shutil.rmtree(COMFY_DIR, ignore_errors=True)
        staging.rename(COMFY_DIR)

        self._engine_step(0.12, f"Installing Python {PYTHON_VERSION}")
        shutil.rmtree(ENGINE_VENV, ignore_errors=True)
        await self._uv(uv, ["venv", str(ENGINE_VENV), "--python", PYTHON_VERSION], 0.12, 0.2)

        self._engine_step(0.2, "Installing PyTorch and ComfyUI packages")
        # Relative file names: uv splits a -c path at spaces ("Application Support").
        await self._uv(uv, ["pip", "install", "--python", str(ENGINE_VENV / "bin" / "python"),
                            "-r", "requirements.txt", "-c", "constraints.txt"], 0.2, 0.98, cwd=ENGINE_FILES)
        self.stamp_file.write_text(json.dumps({"stamp": self.stamp(), "comfy": COMFY_VERSION,
                                               "installed_at": time.time()}))
        self._engine_step(1.0, "Engine installed")


class MossInstaller(Installer):
    model = "moss"
    title = "MOSS-Image"
    engine_label = "Python and MLX"
    engine_bytes = 600_000_000
    files = MOSS_FILES
    stamp_file = MOSS_ENGINE_DIR / "installed.json"

    @staticmethod
    def stamp() -> str:
        return _stamp(MOSS_PACKAGE, (ENGINE_FILES / "moss-constraints.txt").read_bytes())

    def engine_ready(self) -> bool:
        return _stamp_ok(self.stamp_file, self.stamp()) and (MOSS_VENV / "bin" / "python").exists()

    async def install_engine(self, uv: str) -> None:
        MOSS_ENGINE_DIR.mkdir(parents=True, exist_ok=True)
        self._engine_step(0.05, f"Installing Python {PYTHON_VERSION}")
        shutil.rmtree(MOSS_VENV, ignore_errors=True)
        await self._uv(uv, ["venv", str(MOSS_VENV), "--python", PYTHON_VERSION], 0.05, 0.2)
        self._engine_step(0.2, "Installing MLX and moss-image-mlx")
        await self._uv(uv, ["pip", "install", "--python", str(MOSS_VENV / "bin" / "python"), MOSS_PACKAGE,
                            "-c", "moss-constraints.txt"], 0.2, 0.98, cwd=ENGINE_FILES)
        self.stamp_file.write_text(json.dumps({"stamp": self.stamp(), "package": MOSS_PACKAGE,
                                               "installed_at": time.time()}))
        self._engine_step(1.0, "Engine installed")


def _hash_file(path: Path, hasher) -> None:
    with open(path, "rb") as fh:
        while chunk := fh.read(16 * 1024 * 1024):
            hasher.update(chunk)


def _extract_root(archive: Path, dest: Path) -> None:
    """Extracts a GitHub source tarball, dropping its single top-level folder."""
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        root = members[0].name.split("/")[0]
        for mem in members:
            parts = mem.name.split("/", 1)
            if parts[0] != root or len(parts) == 1 or not parts[1]:
                continue
            mem.name = parts[1]
            tar.extract(mem, dest, filter="data")


installers: dict[str, Installer] = {"qwen": QwenInstaller(), "moss": MossInstaller()}
installer = installers["qwen"]


def ready() -> bool:
    """Qwen engine and models present (used by the ComfyUI engine)."""
    return installers["qwen"].ready()
