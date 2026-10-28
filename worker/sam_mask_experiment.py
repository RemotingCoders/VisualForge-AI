"""EXPERIMENT (not production): figure out SAM mask payload decoding OFFLINE from a saved
spike output (spike-output/sam.json), so no extra paid calls are ever needed to iterate.

Verified facts (docs): payload is base85, data=H,W (H=rows first), '~'=lossless, '!'=one_bit,
decodeMaskToRaster returns row-major 0/1 with exactly H*W entries.
Not verified: the byte layout inside the payload. This script tries the documented-shaped
candidates and reports which one yields exactly H*W bits with a plausible fill ratio —
production code keeps using pixel-diff measurement until /docs/sam/client-libraries is verified.

Usage: python3 -I worker/sam_mask_experiment.py spike-output/sam.json
"""
import base64
import json
import re
import sys
import zlib

TOKEN = re.compile(r"<\|mask;x=0;y=0(?:;c=[\d.]+)?;data=(\d+),(\d+),([~!])([^|]*)\|>")


def candidates(payload: str, h: int, w: int):
    try:
        raw = base64.b85decode(payload)
    except Exception as e:  # noqa: BLE001
        print(f"  b85decode failed: {e}")
        return
    yield "one_bit: b85 -> bits MSB-first", [(byte >> (7 - i)) & 1 for byte in raw for i in range(8)]
    yield "one_bit: b85 -> bits LSB-first", [(byte >> i) & 1 for byte in raw for i in range(8)]
    for name, blob in (("zlib", None),):
        try:
            dec = zlib.decompress(raw)
            yield f"lossless: b85 -> {name} -> bytes as bits MSB", [(b >> (7 - i)) & 1 for b in dec for i in range(8)]
            yield f"lossless: b85 -> {name} -> bytes 0/1", [1 if b else 0 for b in dec]
        except Exception as e:  # noqa: BLE001
            print(f"  {name} decompress failed: {e}")


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    text = json.load(open(sys.argv[1]))["output_text"]
    masks = list(TOKEN.finditer(text))
    print(f"{len(masks)} mask token(s)")
    for m in masks:
        h, w, enc, payload = int(m.group(1)), int(m.group(2)), m.group(3), m.group(4)
        print(f"mask H={h} W={w} enc={enc} payload_chars={len(payload)} expected_entries={h * w}")
        for name, bits in candidates(payload, h, w):
            if len(bits) >= h * w:
                fill = sum(bits[: h * w]) / (h * w)
                print(f"  {name}: len={len(bits)} fill_ratio={fill:.3f} {'<== PLAUSIBLE' if 0.01 < fill < 0.99 else ''}")
            else:
                print(f"  {name}: len={len(bits)} (too short)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
