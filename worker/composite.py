"""VisualForge worker: compositing + real mask/bbox measurement.
Pixels outside masks stay identical to the original — this is tested.
Deploy target: Vercel Python Function if size/duration fit; otherwise STOP and propose Modal (no paid infra without Damian's approval)."""
import numpy as np
from PIL import Image


def composite(original: Image.Image, edited: Image.Image, mask: Image.Image, feather: int = 2) -> Image.Image:
    # `mask` arrives pre-feathered by the caller (alpha in 0..255); feather kept in the signature
    # for the spike, where we compare feather radii. Outside mask alpha=0 -> pixel-identical (tested).
    if original.size != edited.size:
        raise ValueError("size mismatch")
    o, e, m = np.asarray(original).astype(np.float32), np.asarray(edited).astype(np.float32), np.asarray(mask.convert("L")).astype(np.float32) / 255.0
    if m.ndim == 2:
        m = m[..., None]
    return Image.fromarray(np.clip(o * (1 - m) + e * m, 0, 255).astype(np.uint8))


def measure_mask(original: Image.Image, modified: Image.Image, threshold: int = 12) -> np.ndarray:
    a, b = np.asarray(original).astype(int), np.asarray(modified).astype(int)
    if a.shape != b.shape:
        raise ValueError("shape mismatch")
    return np.abs(a - b).max(axis=2) > threshold if a.ndim == 3 else np.abs(a - b) > threshold


def mask_to_bbox(mask: np.ndarray):
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return None
    return {"x": int(xs.min()), "y": int(ys.min()), "width": int(xs.max() - xs.min() + 1), "height": int(ys.max() - ys.min() + 1)}
