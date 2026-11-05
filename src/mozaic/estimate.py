"""Rough time estimates for the queue, calibrated from how long finished jobs took on this Mac.

A job's time per image is an overhead (text encoding, VAE, saving) plus its sampling steps times a rate that
grows a little faster than the pixel count. The rate for each kind of job is the median of the last finished
jobs of that kind; until there are any, it comes from M1 Max timings scaled by this Mac's chip and GPU.
"""

from __future__ import annotations

import math
import re
import statistics
import subprocess
import time
from collections import defaultdict
from functools import lru_cache
from typing import Any

from . import library

# Seconds per image outside the sampling steps.
OVERHEAD = {"qwen": 40.0, "qwen-edit": 45.0, "moss": 30.0, "moss-turbo": 30.0}
# Seconds per sampling step per megapixel^SIZE_EXPONENT on an M1 Max with a 32-core GPU. Measured with
# Qwen: 1 MP generate 18 s/step, 4.2 MP generate 101 s/step, 3.4 MP cutout (6.8 MP with its reference) 133 s/step.
BASE_RATE = {"qwen": 17.0, "qwen-edit": 12.0, "moss": 16.5, "moss-turbo": 7.5}
# Attention makes big images cost more than their pixel count alone.
SIZE_EXPONENT = 1.25
HISTORY = 12

_rates: dict[str, float] | None = None


def kind(op: str, p: dict) -> str:
    if p.get("model") == "moss":
        return "moss-turbo" if p.get("turbo") else "moss"
    return "qwen" if op == "generate" else "qwen-edit"


def steps(op: str, p: dict) -> int:
    return 15 if kind(op, p) == "moss-turbo" else int(p.get("steps") or 30)


def megapixels(op: str, p: dict) -> float:
    """The pixels the model works on, in MP: the output, plus every reference image for edits, since those
    are part of the sequence each step attends over."""
    if op == "generate":
        return int(p.get("width") or 1024) * int(p.get("height") or 1024) / 1e6
    src = p.get("image") or (p.get("images") or [None])[0]
    a = library.get(src) if src else None
    w, h = (a["width"], a["height"]) if a else (1024, 1024)
    if op == "expand":
        w, h = w + int(p.get("left") or 0) + int(p.get("right") or 0), h + int(p.get("top") or 0) + int(p.get("bottom") or 0)
    if op == "remix":
        area = min(w * h * float(p.get("scale") or 1) ** 2, 2048 * 2048 * 1.1) / 1e6
        return area * (2 if p.get("use_reference") else 1)
    # Edits run at the input's size capped at 2048², or at the requested resolution.
    side = min(2048, int(p["resolution"])) if p.get("resolution") not in (None, "", "match") else min(2048, math.sqrt(w * h))
    refs = {"edit": len(p.get("images") or [1]),
            "region": 1 + len(p.get("references") or []) + (1 if p.get("method") == "mask" else 0)}.get(op, 1)
    if op == "region" and p.get("method") == "repaint":
        refs = len(p.get("references") or [])
    return side * side * (1 + refs) / 1e6


def units(op: str, p: dict) -> float:
    return steps(op, p) * max(0.05, megapixels(op, p)) ** SIZE_EXPONENT


def invalidate() -> None:
    global _rates
    _rates = None


def rates() -> dict[str, float]:
    global _rates
    if _rates is None:
        samples: dict[str, list[float]] = defaultdict(list)
        for j in library.recent_jobs(300):
            p = j["params"] or {}
            if j["status"] != "done" or not j["started_at"] or not j["finished_at"] or p.get("crop_only"):
                continue
            k = kind(j["op"], p)
            if len(samples[k]) >= HISTORY:
                continue
            try:
                u = units(j["op"], p)
            except Exception:
                continue
            per_image = (j["finished_at"] - j["started_at"]) / max(1, len(j["outputs"]) or int(p.get("count") or 1))
            samples[k].append(max(0.5, per_image - OVERHEAD[k]) / u)
        _rates = {k: statistics.median(v) for k, v in samples.items() if v}
    return _rates


@lru_cache(maxsize=1)
def hardware_factor() -> float:
    """How much slower than an M1 Max this Mac is likely to be, from its chip generation and GPU cores."""
    try:
        chip = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True,
                              timeout=3).stdout
        io = subprocess.run(["ioreg", "-rc", "AGXAccelerator", "-d", "1"], capture_output=True, text=True,
                            timeout=3).stdout
        cores = int(re.search(r'"gpu-core-count" = (\d+)', io).group(1))
        gen = int(m.group(1)) if (m := re.search(r"M(\d+)", chip)) else 1
    except Exception:
        return 1.0
    speed = cores / 32 * {1: 1.0, 2: 1.15, 3: 1.3, 4: 1.45}.get(gen, 1.45 + 0.4 * (gen - 4))
    return 1 / max(0.1, speed)


def rate(k: str) -> float:
    return rates().get(k) or BASE_RATE[k] * hardware_factor()


def per_image(op: str, p: dict) -> float:
    k = kind(op, p)
    return OVERHEAD[k] + rate(k) * units(op, p)


def remaining(job: Any, now: float | None = None) -> float | None:
    """Seconds until the job is done, or None when it can't be estimated."""
    try:
        now = now or time.time()
        each = per_image(job.op, job.params)
        if job.status != "running":
            return max(0, job.count - job.completed) * each
        after = max(0, job.count - job.index - 1)
        clock = job.step_clock
        if clock and job.step > clock[0]:
            # The running image's own pace is the best guess for the rest of this job.
            per_step = (now - clock[1]) / (job.step - clock[0])
            overhead = OVERHEAD[kind(job.op, job.params)]
            current = (job.steps - job.step) * per_step + overhead * 0.25
            each = overhead + per_step * job.steps
        else:
            current = max(each * 0.1, each - (now - (job.image_started_at or now)))
        return current + after * each
    except Exception:
        return None
