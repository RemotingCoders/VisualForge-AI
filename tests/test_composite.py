import numpy as np
from PIL import Image
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "worker"))
from composite import composite, measure_mask, mask_to_bbox


def img(color, size=(8, 8)):
    return Image.new("RGB", size, color)


def test_outside_mask_identical():
    mask = Image.new("L", (8, 8), 0)
    for x in range(2, 4):
        for y in range(2, 4):
            mask.putpixel((x, y), 255)
    out = composite(img((200, 0, 0)), img((0, 0, 200)), mask)
    assert out.getpixel((0, 0)) == (200, 0, 0)  # outside: untouched
    assert out.getpixel((2, 2)) == (0, 0, 200)  # inside: edited


def test_measure_and_bbox():
    a, b = img((10, 10, 10)), img((10, 10, 10))
    b.putpixel((5, 3), (250, 10, 10))
    m = measure_mask(a, b)
    assert mask_to_bbox(m) == {"x": 5, "y": 3, "width": 1, "height": 1}
    assert mask_to_bbox(np.zeros((8, 8), dtype=bool)) is None
