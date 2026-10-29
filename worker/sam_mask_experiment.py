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
    raw = None
    for name, fn in (("b85decode", lambda: base64.b85decode(payload)), ("a85decode", lambda: base64.a85decode(payload, adobe=False))):
        try:
            raw = fn()
            print(f"  {name}: {len(raw)} bytes")
            break
        except Exception as e:  # noqa: BLE001
            print(f"  {name} failed: {e}")
    if raw is None:
        return
    yield "bytes -> bits MSB-first", [(byte >> (7 - i)) & 1 for byte in raw for i in range(8)]
    yield "bytes -> bits LSB-first", [(byte >> i) & 1 for byte in raw for i in range(8)]
    for wbits in (zlib.MAX_WBITS, -zlib.MAX_WBITS):
        try:
            dec = zlib.decompress(raw, wbits)
            print(f"  zlib(wbits={wbits}): {len(dec)} bytes")
            yield f"zlib({wbits}) -> bits MSB-first", [(b >> (7 - i)) & 1 for b in dec for i in range(8)]
            yield f"zlib({wbits}) -> bytes 0/1", [1 if b else 0 for b in dec]
        except Exception as e:  # noqa: BLE001
            print(f"  zlib(wbits={wbits}) failed: {e}")


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
