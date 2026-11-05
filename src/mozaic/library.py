"""The image library: files on disk plus a SQLite index with prompts, parameters and lineage."""

from __future__ import annotations

import io
import json
import shutil
import sqlite3
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

from PIL import Image

from . import config

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    name TEXT,
    width INTEGER, height INTEGER,
    has_alpha INTEGER DEFAULT 0,
    source TEXT,            -- generated | edited | imported
    op TEXT,                -- generate | edit | region | expand | cutout | remix | adjust | transform | import
    prompt TEXT,
    params TEXT,            -- JSON of the job params that produced it
    parents TEXT,           -- JSON list of asset ids used as inputs
    job_id TEXT,
    favorite INTEGER DEFAULT 0,
    hidden INTEGER DEFAULT 0, -- inputs like masks are kept but not listed
    created_at REAL
);
CREATE INDEX IF NOT EXISTS assets_created ON assets(created_at DESC);
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    op TEXT, params TEXT, status TEXT, error TEXT,
    outputs TEXT, text TEXT,
    created_at REAL, started_at REAL, finished_at REAL
);
"""


def db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        config.ensure_dirs()
        _conn = sqlite3.connect(config.DB_FILE, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.executescript(SCHEMA)
        # Columns added after the first release.
        cols = {r[1] for r in _conn.execute("PRAGMA table_info(jobs)")}
        for col, kind in (("source", "TEXT"), ("position", "INTEGER")):
            if col not in cols:
                _conn.execute(f"ALTER TABLE jobs ADD COLUMN {col} {kind}")
        _conn.commit()
    return _conn


def _row(r: sqlite3.Row | None) -> dict | None:
    if r is None:
        return None
    d = dict(r)
    d["has_alpha"] = bool(d["has_alpha"])
    d["favorite"] = bool(d["favorite"])
    d["hidden"] = bool(d["hidden"])
    d["params"] = json.loads(d["params"] or "{}")
    d["parents"] = json.loads(d["parents"] or "[]")
    return d


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def normalize(img: Image.Image) -> tuple[Image.Image, bool]:
    """Returns the image as RGB, or RGBA when the alpha channel is actually used."""
    if img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info):
        img = img.convert("RGBA")
        # The Qwen 2.1 VAE always decodes an alpha channel; opaque images come back at 252-255.
        see_through = sum(img.getchannel("A").histogram()[:240])
        if see_through > img.width * img.height * 0.0005:
            return img, True
        return img.convert("RGB"), False
    return img.convert("RGB"), False


def add_image(img: Image.Image, *, source: str, op: str, prompt: str = "", params: dict | None = None,
              parents: list[str] | None = None, job_id: str | None = None, name: str | None = None,
              hidden: bool = False) -> dict:
    img, has_alpha = normalize(img)
    s = config.load_settings()
    aid = new_id()
    folder = Path(s.library_dir) / (".inputs" if hidden else datetime.now().strftime("%Y-%m"))
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{op}-{aid}.png"
    img.save(path, "PNG", compress_level=4)
    _thumb(img, aid)
    with _lock:
        db().execute(
            "INSERT INTO assets (id, path, name, width, height, has_alpha, source, op, prompt, params, parents, job_id, hidden, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (aid, str(path), name or "", img.width, img.height, int(has_alpha), source, op, prompt,
             json.dumps(params or {}), json.dumps(parents or []), job_id, int(hidden), time.time()))
        db().commit()
    return get(aid)


def import_bytes(data: bytes, name: str = "", hidden: bool = False) -> dict:
    img = Image.open(io.BytesIO(data))
    img.load()
    return add_image(img, source="imported", op="import", name=name, hidden=hidden)


def _thumb(img: Image.Image, aid: str) -> None:
    t = img.copy()
    t.thumbnail((512, 512), Image.Resampling.LANCZOS)
    t.save(config.THUMB_DIR / f"{aid}.webp", "WEBP", quality=82)


def thumb_path(aid: str) -> Path | None:
    p = config.THUMB_DIR / f"{aid}.webp"
    if p.exists():
        return p
    a = get(aid)
    if not a or not Path(a["path"]).exists():
        return None
    with Image.open(a["path"]) as img:
        _thumb(img, aid)
    return p


def get(aid: str) -> dict | None:
    return _row(db().execute("SELECT * FROM assets WHERE id=?", (aid,)).fetchone())


def open_image(aid: str) -> Image.Image:
    a = get(aid)
    if not a:
        raise KeyError(f"Unknown image id {aid}")
    img = Image.open(a["path"])
    img.load()
    return img


def list_assets(limit: int = 100, offset: int = 0, query: str = "", favorites: bool = False,
                op: str = "", include_hidden: bool = False) -> list[dict]:
    where, args = [], []
    if not include_hidden:
        where.append("hidden=0")
    if favorites:
        where.append("favorite=1")
    if op:
        where.append("op=?")
        args.append(op)
    if query:
        where.append("(prompt LIKE ? OR name LIKE ?)")
        args += [f"%{query}%", f"%{query}%"]
    sql = "SELECT * FROM assets" + (" WHERE " + " AND ".join(where) if where else "")
    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
    return [_row(r) for r in db().execute(sql, (*args, limit, offset)).fetchall()]


def count_assets() -> int:
    return db().execute("SELECT COUNT(*) FROM assets WHERE hidden=0").fetchone()[0]


def update(aid: str, **fields) -> dict | None:
    allowed = {k: v for k, v in fields.items() if k in ("favorite", "name", "hidden")}
    if allowed:
        sets = ", ".join(f"{k}=?" for k in allowed)
        with _lock:
            db().execute(f"UPDATE assets SET {sets} WHERE id=?",
                         (*[int(v) if isinstance(v, bool) else v for v in allowed.values()], aid))
            db().commit()
    return get(aid)


def trash(aid: str) -> bool:
    """Moves the file to the macOS Trash (recoverable) and drops it from the index."""
    a = get(aid)
    if not a:
        return False
    p = Path(a["path"])
    if p.exists():
        trash_dir = Path.home() / ".Trash"
        dest = trash_dir / p.name
        if dest.exists():
            dest = trash_dir / f"{p.stem}-{int(time.time())}{p.suffix}"
        shutil.move(str(p), dest)
    (config.THUMB_DIR / f"{aid}.webp").unlink(missing_ok=True)
    with _lock:
        db().execute("DELETE FROM assets WHERE id=?", (aid,))
        db().commit()
    return True


# ---------- jobs ----------

def save_job(job: dict) -> None:
    with _lock:
        db().execute(
            "INSERT OR REPLACE INTO jobs (id, op, params, status, error, outputs, text, created_at, started_at,"
            " finished_at, source, position) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (job["id"], job["op"], json.dumps(job["params"]), job["status"], job.get("error"),
             json.dumps(job.get("outputs", [])), job.get("text"), job["created_at"], job.get("started_at"),
             job.get("finished_at"), job.get("source"), job.get("position")))
        db().commit()


def load_job(jid: str) -> dict | None:
    r = db().execute("SELECT * FROM jobs WHERE id=?", (jid,)).fetchone()
    if not r:
        return None
    d = dict(r)
    d["params"] = json.loads(d["params"] or "{}")
    d["outputs"] = json.loads(d["outputs"] or "[]")
    return d


def unfinished_jobs() -> list[dict]:
    """Jobs still queued, paused or running, in their queue order."""
    rows = db().execute("SELECT id FROM jobs WHERE status IN ('queued', 'paused', 'running')"
                        " ORDER BY status != 'running', position IS NULL, position, created_at").fetchall()
    return [load_job(r["id"]) for r in rows]


def recent_jobs(limit: int = 50) -> list[dict]:
    rows = db().execute("SELECT id FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    return [load_job(r["id"]) for r in rows]
