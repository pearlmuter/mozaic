"""Paths, defaults and persisted user settings."""

from __future__ import annotations

import json
import os
import threading
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

APP_NAME = "Mozaic"
HOME = Path.home()
APP_SUPPORT = Path(os.environ.get("MOZAIC_HOME", HOME / "Library" / "Application Support" / APP_NAME))
SETTINGS_FILE = APP_SUPPORT / "settings.json"
DB_FILE = APP_SUPPORT / "mozaic.db"
THUMB_DIR = APP_SUPPORT / "thumbs"
COMFY_STATE_DIR = APP_SUPPORT / "comfy"
LOG_DIR = APP_SUPPORT / "logs"

DEFAULT_PORT = 47811
DEFAULT_COMFY_PORT = 47812

COMFY_DESKTOP_DIR = HOME / "Library" / "Application Support" / "Comfy Desktop"

# Official Qwen Image 2.1 aspect ratios at native 2K (from the model card).
ASPECT_RATIOS: dict[str, tuple[int, int]] = {
    "1:1": (2048, 2048),
    "4:3": (2400, 1792),
    "3:4": (1792, 2400),
    "3:2": (2528, 1696),
    "2:3": (1696, 2528),
    "16:9": (2752, 1536),
    "9:16": (1536, 2752),
}

RGBA_PREFIX = "This is an RGBA format image with transparency. "
RGBA_SUFFIX = " The image has an alpha channel and a transparent background."


@dataclass
class Settings:
    # Engine. "bundled": Mozaic's own ComfyUI in APP_SUPPORT/engine (installed on first run);
    # "custom": run another ComfyUI folder headless; "external": connect to a running ComfyUI at comfy_url.
    comfy_mode: str = "bundled"
    comfy_path: str = ""
    comfy_url: str = ""
    comfy_port: int = DEFAULT_COMFY_PORT
    models_dirs: list[str] = field(default_factory=list)  # extra model folders, e.g. for LoRAs
    auto_start_engine: bool = True
    # Models (empty = auto-pick)
    unet: str = ""
    weight_dtype: str = "default"
    text_encoder: str = ""
    vae: str = ""
    # KV cache (QwenImage21Cache)
    cache_device: str = "auto"
    cache_dtype: str = "default"
    # Sampling defaults
    steps: int = 30
    cfg: float = 1.0
    sampler: str = "euler"
    scheduler: str = "simple"
    megapixels: float = 1.0
    # Which model is loaded: "qwen" (Qwen Image 2.1 on ComfyUI) or "moss" (MOSS-Image on MLX)
    active_model: str = "qwen"
    # MOSS-Image: "sft" (recommended) or "base"; keep_resident keeps the text encoder and transformer loaded
    # between images (faster, ~18 GB), otherwise each is loaded and freed per image (~10 GB peak).
    moss_checkpoint: str = "sft"
    moss_keep_resident: bool = True
    # Library
    library_dir: str = str(HOME / "Pictures" / APP_NAME)

    def resolved_comfy_url(self) -> str:
        if self.comfy_mode == "external" and self.comfy_url:
            return self.comfy_url.rstrip("/")
        return f"http://127.0.0.1:{self.comfy_port}"


_lock = threading.Lock()
_settings: Settings | None = None


def load_settings() -> Settings:
    global _settings
    with _lock:
        if _settings is not None:
            return _settings
        s = Settings()
        if SETTINGS_FILE.exists():
            try:
                raw = json.loads(SETTINGS_FILE.read_text())
                known = {f.name for f in fields(Settings)}
                for k, v in raw.items():
                    if k in known:
                        setattr(s, k, v)
            except Exception:
                pass
        if s.comfy_mode == "managed":  # setting name used before Mozaic had its own engine
            s.comfy_mode = "custom" if s.comfy_path else "bundled"
        _settings = s
        return s


def save_settings(updates: dict) -> Settings:
    s = load_settings()
    known = {f.name for f in fields(Settings)}
    with _lock:
        for k, v in updates.items():
            if k in known:
                setattr(s, k, v)
        APP_SUPPORT.mkdir(parents=True, exist_ok=True)
        SETTINGS_FILE.write_text(json.dumps(asdict(s), indent=2))
    return s


def settings_dict() -> dict:
    return asdict(load_settings())


def ensure_dirs() -> None:
    s = load_settings()
    for d in (APP_SUPPORT, THUMB_DIR, COMFY_STATE_DIR, LOG_DIR, Path(s.library_dir)):
        d.mkdir(parents=True, exist_ok=True)
