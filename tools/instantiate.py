#!/usr/bin/env python3
"""Instantiate a static TTF from a variable font at arbitrary axis values.
Usage: instantiate.py <src.ttf|woff2> <axes-json> <out.ttf>

This is what powers custom-axis support (GRAD, XOPQ, YOPQ, XTRA, YTAS, ...)
that the browser canvas `font` shorthand cannot express. Registered axes
(wght/wdth/slnt/opsz) are handled natively in-browser; custom axes come here.
"""
import json
import os
import sys
import tempfile

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont, OverlapMode


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: instantiate.py <src> <axes-json> <out>", file=sys.stderr)
        return 2
    src, axes_raw, out = sys.argv[1], sys.argv[2], sys.argv[3]

    try:
        axes = json.loads(axes_raw)
    except Exception as e:  # noqa: BLE001
        print(f"bad axes json: {e}", file=sys.stderr)
        return 2

    if not os.path.exists(src):
        print(f"source not found: {src}", file=sys.stderr)
        return 4
    try:
        font = TTFont(src, lazy=False)
    except Exception as e:  # noqa: BLE001
        print(f"cannot open font: {e}", file=sys.stderr)
        return 4
    if "fvar" not in font:
        print("source is not a variable font", file=sys.stderr)
        return 3

    valid = {a.axisTag: (a.minValue, a.defaultValue, a.maxValue) for a in font["fvar"].axes}
    pinned = {}
    for tag, val in axes.items():
        if tag not in valid:
            continue
        lo, dflt, hi = valid[tag]
        try:
            val = float(val)
        except (TypeError, ValueError):
            continue
        pinned[tag] = min(max(val, lo), hi)

    if not pinned:
        # nothing to pin -> just export a default instance
        pinned = {t: v[1] for t, v in valid.items()}

    # static=True fully removes fvar/gvar so the browser gets a plain static TTF;
    # overlap=REMOVE resolves TrueType outline overlaps introduced by the instancer.
    # REMOVE needs the optional `skia-pathops` dep; degrade gracefully if absent.
    try:
        import pathops  # noqa: F401
        overlap = OverlapMode.REMOVE
    except ImportError:
        overlap = OverlapMode.KEEP_AND_SET_FLAGS
    instantiateVariableFont(font, pinned, inplace=True, static=True, overlap=overlap)

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".ttf", dir=os.path.dirname(os.path.abspath(out)))
    tmp.close()
    font.save(tmp.name)
    os.replace(tmp.name, out)
    print(f"ok {out} axes={pinned}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
