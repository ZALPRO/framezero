#!/usr/bin/env python3
"""Emit JSON metadata for every font in a directory: variable axes + script coverage.
Powers the in-app Font Library panel and the Font Clearance Report.
Usage: fontinfo.py <fonts-dir>
"""
import glob
import json
import os
import sys

from fontTools.ttLib import TTFont

# Unicode ranges we care about for script coverage reporting
SCRIPTS = {
    "Latin Basic": (0x0041, 0x007A),
    "Latin Ext": (0x0100, 0x024F),
    "Arabic": (0x0600, 0x06FF),
    "Arabic Supplement": (0x0750, 0x077F),
    "Arabic Pres Forms A": (0xFB50, 0xFDFF),
    "Arabic Pres Forms B": (0xFE70, 0xFEFF),
    "Hebrew": (0x0590, 0x05FF),
    "Devanagari": (0x0900, 0x097F),
    "Cyrillic": (0x0400, 0x04FF),
    "Greek": (0x0370, 0x03FF),
    "CJK": (0x4E00, 0x9FFF),
    "Hangul": (0xAC00, 0xD7AF),
}

# Characters that MUST exist for correct Persian (Farsi) typesetting
PERSIAN_REQUIRED = {
    "پ": 0x067E, "چ": 0x0686, "ژ": 0x0698, "گ": 0x06AF, "ی": 0x06CC,
    "ک": 0x06A9, "۰": 0x06F0, "۱": 0x06F1, "۲": 0x06F2, "۳": 0x06F3,
    "۴": 0x06F4, "۵": 0x06F5, "۶": 0x06F6, "۷": 0x06F7, "۸": 0x06F8, "۹": 0x06F9,
    "؟": 0x061F, "؛": 0x061B, "،": 0x060C, "": 0x200C,  # ZWNJ - critical for Persian
}
ARABIC_REQUIRED = {
    "ا": 0x0627, "ب": 0x0628, "ت": 0x062A, "ث": 0x062B, "ج": 0x062C,
    "ح": 0x062D, "خ": 0x062E, "د": 0x062F, "ذ": 0x0630, "ر": 0x0631,
    "ز": 0x0632, "س": 0x0633, "ش": 0x0634, "ص": 0x0635, "ض": 0x0636,
    "ط": 0x0637, "ظ": 0x0638, "ع": 0x0639, "غ": 0x063A, "ف": 0x0641,
    "ق": 0x0642, "ك": 0x0643, "ل": 0x0644, "م": 0x0645, "ن": 0x0646,
    "ه": 0x0647, "و": 0x0648, "ي": 0x064A,
}
# Presentation forms needed for correct joined rendering when the shaper
# does not rely on OpenType (belt-and-braces check)
PRESFORM_REQUIRED = [0xFE8E, 0xFE90, 0xFEF2, 0xFB7B, 0xFB9B, 0xFB8B]


def coverage(cmap: dict, required: dict) -> dict:
    have = sum(1 for cp in required.values() if cp in cmap)
    missing = [ch for ch, cp in required.items() if cp not in cmap and ch.strip()]
    return {"have": have, "total": len(required), "pct": round(100 * have / max(1, len(required)), 1),
            "missing": missing[:12]}


def describe(path: str) -> dict:
    name = os.path.basename(path)
    try:
        f = TTFont(path, fontNumber=0, lazy=True)
    except Exception as e:  # noqa: BLE001
        return {"file": name, "error": str(e)[:200]}

    out = {"file": name, "size_kb": round(os.path.getsize(path) / 1024)}

    try:
        nm = f["name"]
        out["family"] = nm.getDebugName(16) or nm.getDebugName(1) or name
        out["subfamily"] = nm.getDebugName(17) or nm.getDebugName(2) or ""
    except Exception:  # noqa: BLE001
        out["family"] = name

    # variable axes
    axes = []
    if "fvar" in f:
        out["variable"] = True
        for a in f["fvar"].axes:
            axes.append({
                "tag": a.axisTag,
                "min": round(a.minValue, 3),
                "default": round(a.defaultValue, 3),
                "max": round(a.maxValue, 3),
                # registered axes are expressible through the CSS/canvas font shorthand
                "registered": a.axisTag in ("wght", "wdth", "slnt", "opsz", "ital"),
            })
    else:
        out["variable"] = False
    out["axes"] = axes

    # named instances
    try:
        out["instances"] = len(f["fvar"].instances) if "fvar" in f else 0
    except Exception:  # noqa: BLE001
        out["instances"] = 0

    # cmap coverage
    try:
        cmap = f.getBestCmap() or {}
    except Exception:  # noqa: BLE001
        cmap = {}
    out["glyph_count"] = len(cmap)
    out["scripts"] = {}
    for sname, (lo, hi) in SCRIPTS.items():
        n = sum(1 for cp in cmap if lo <= cp <= hi)
        if n:
            out["scripts"][sname] = n
    out["persian"] = coverage(cmap, PERSIAN_REQUIRED)
    out["arabic"] = coverage(cmap, ARABIC_REQUIRED)
    out["pres_forms"] = sum(1 for cp in PRESFORM_REQUIRED if cp in cmap)

    # OpenType feature tags present (liga/calt are required for correct shaping)
    feats = set()
    for tag in ("GSUB",):
        try:
            if tag in f:
                for fr in f[tag].table.FeatureList.FeatureRecord:
                    feats.add(fr.FeatureTag)
        except Exception:  # noqa: BLE001
            pass
    out["features"] = sorted(feats)
    out["has_liga"] = "liga" in feats
    out["has_calt"] = "calt" in feats
    out["has_rclt"] = "rclt" in feats or "rlig" in feats
    return out


def main() -> int:
    d = sys.argv[1] if len(sys.argv) > 1 else "."
    fonts = []
    for path in sorted(glob.glob(os.path.join(d, "*"))):
        if os.path.splitext(path)[1].lower() in (".ttf", ".otf", ".woff", ".woff2"):
            fonts.append(describe(path))
    json.dump({"fonts": fonts}, sys.stdout, ensure_ascii=False, indent=1)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
