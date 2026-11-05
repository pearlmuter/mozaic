"""MOSS-Image worker. Runs in the MOSS engine's own Python (it imports moss_image_mlx, not mozaic).

Protocol: one JSON object per line.
  stdin:  {"cmd": "generate", "id": ..., "config": {...}, "request": {...}, "output": "/path.png"}
          {"cmd": "cancel", "id": ...}
          {"cmd": "unload"}
  stdout: {"type": "ready"} once, then per job {"type": "phase"|"progress"|"done"|"error"|"cancelled", "id": ...}
The pipeline stays loaded between jobs and is rebuilt only when the config (checkpoint, turbo, LoRAs) changes.
"""

from __future__ import annotations

import json
import sys
import threading
import time
import traceback
from dataclasses import fields
from pathlib import Path
from queue import Queue

_out_lock = threading.Lock()


def send(**msg) -> None:
    with _out_lock:
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()


class Cancelled(Exception):
    pass


def main() -> None:
    import mlx.core as mx
    from PIL import Image

    from moss_image_mlx import MOSSImagePipeline, Request
    from moss_image_mlx.turbo import DESTRIPE

    jobs: Queue = Queue()
    cancelled: set = set()

    def reader() -> None:
        for line in sys.stdin:
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("cmd") == "cancel":
                cancelled.add(msg.get("id"))
            else:
                jobs.put(msg)
        jobs.put({"cmd": "exit"})

    threading.Thread(target=reader, daemon=True).start()
    request_fields = {f.name for f in fields(Request)}
    pipe = None
    pipe_key = None
    send(type="ready")

    while True:
        msg = jobs.get()
        cmd = msg.get("cmd")
        if cmd == "exit":
            return
        if cmd == "unload":
            pipe, pipe_key = None, None
            mx.clear_cache()
            continue
        if cmd != "generate":
            continue
        jid = msg["id"]
        if jid in cancelled:
            send(type="cancelled", id=jid)
            continue
        cfg = msg["config"]
        try:
            key = json.dumps(cfg, sort_keys=True)
            if pipe is None or key != pipe_key:
                send(type="phase", id=jid, phase="Loading model")
                pipe = None
                mx.clear_cache()
                loras = []
                if cfg.get("turbo"):
                    # Same order as the moss-mlx CLI: destripe always on, then the student switched per step.
                    loras = [(cfg["destripe"], DESTRIPE["strength"], mx.bfloat16, "destripe"),
                             (cfg["student"], 1.0, mx.float32, "student")]
                loras += [(l["path"], float(l["strength"])) for l in cfg.get("loras", [])]
                pipe = MOSSImagePipeline(cfg["model_dir"], cfg.get("transformer_dir"),
                                         low_memory=not cfg.get("keep_resident", True),
                                         cache_dir=cfg.get("cache_dir"), loras=loras)
                pipe_key = key
            req = Request(**{k: v for k, v in msg["request"].items() if k in request_fields})
            started = time.time()

            def on_step(i: int, n: int) -> None:
                if jid in cancelled:
                    raise Cancelled()
                send(type="progress", id=jid, step=i + 1, total=n)

            send(type="phase", id=jid, phase="Reading prompt")
            # generate_many encodes the prompt, then denoises; the first step callback switches the phase.
            for _, image in pipe.generate_many([req], on_step=on_step):
                send(type="phase", id=jid, phase="Decoding")
                out = Path(msg["output"])
                out.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(image).save(out)
                send(type="done", id=jid, output=str(out), seconds=round(time.time() - started, 1),
                     timings=getattr(pipe, "timings", {}))
        except Cancelled:
            send(type="cancelled", id=jid)
        except Exception as e:
            send(type="error", id=jid, error=f"{e.__class__.__name__}: {e}", trace=traceback.format_exc()[-2000:])
            # A failed load leaves the pipeline half-built; start fresh next time.
            pipe, pipe_key = None, None
        finally:
            cancelled.discard(jid)


if __name__ == "__main__":
    main()
