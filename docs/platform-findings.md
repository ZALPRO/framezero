# FrameZero — Verified Platform Findings

Measured with Playwright + Chromium headless (SwiftShader/Vulkan) on 2026-09-17.
Every claim below is backed by `public/probe.html` / `public/probe2.html`.

## 1. Variable fonts in Canvas 2D

| Mechanism | Status | Evidence |
|---|---|---|
| Numeric weight in `ctx.font` → `wght` | **WORKS**, continuous | 100→341px … 900→414px … 1000→427px |
| Ink scales with `wght` | **WORKS** | 1701 → 4988 → 12867 px @ w100/w400/w900 (7.5×) |
| `ctx.fontStretch` (property) | **DEAD** | identical width at 25/62.5/100/151% |
| `font-stretch` keyword in shorthand | works, 9 buckets only | condensed=290, normal=349, expanded=418 |
| `font-stretch` percentage in shorthand | **BREAKS PARSE** | `75%` → 69.7px (falls back to 10px sans-serif) |
| `FontFace(desc.variationSettings)` | **WORKS for custom axes** | see below |
| `FontFace(desc.featureSettings)` | **DEAD** | liga on/off both measure 116px |

### variationSettings is the key unlock
Pixel-measured on Roboto Flex, 72px `Handgloves`:

| Instance | ink px | width px |
|---|---|---|
| baseline | 4513 | 306 |
| `'GRAD' 150` | 6217 | 306 |
| `'XOPQ' 175` | 8010 | 403 |
| `'slnt' -10` | 4498 | 309 |
| `'wdth' 25` | 3304 | 147 |
| `'wdth' 151` | 5257 | 418 |

**Cost of creating one such FontFace: 2.7–4.2 ms** (6 consecutive: 3.2, 3.0, 2.9, 2.7, 2.8, 2.8).
Numeric weight still composes on top of a baked face (306px @ w100 → 412px @ w900).

### Architectural consequences
- Custom axes (GRAD, XOPQ, YOPQ, XTRA, YTUC…) are driven **client-side, live**, no server round-trip.
  The earlier assumption ("custom axes require server-side instantiation") is **wrong** for preview.
- Server-side `fontTools` instantiation is still required for: (a) **export/packaging** a baked static
  font, (b) **OpenType feature control**, since `featureSettings` is dead client-side.
- `wdth` must never be set via shorthand percentages — always via a baked face.
- `document.fonts` grows unbounded → the registry needs **LRU eviction**.

## 2. Complex-script shaping (the After Effects bug, reproduced)

- Vazirmatn & Noto Sans Arabic shape correctly: shaped/isolated ink ratio **0.703 / 0.707**.
- **Inter reports 0% Persian coverage, yet renders Persian at ratio 0.709** — the browser silently
  falls back to a system font. The user sees *a* font, never *their* font. This is exactly the AE
  failure mode; FrameZero detects and surfaces it instead of hiding it.
- Per-cluster prefix measurement is **exactly additive** in both directions
  (RTL: full=172px, Σadvances=172px; LTR likewise). Contextual advances can be **negative**
  (`ا` = −7px) — cluster boxes must be normalised, not assumed positive.
- **Drawing clusters separately destroys joining**: whole-string ink 1639 vs per-cluster 2333 (+42%,
  i.e. isolated glyph forms). Therefore per-glyph animators must draw the **whole line clipped to the
  cluster's box**, preserving shaping context. AE's per-character animator breaks Arabic joining;
  this clip-based approach does not — a demonstrable, testable differentiator.

## 3. GPU backends in this environment

- `navigator.gpu` exists but **`requestAdapter()` returns `null`** → WebGPU is unavailable headless.
  WebGPU stays an *opportunistic upgrade*; it cannot be the required path.
- **WebGL2 is fully available**: `EXT_color_buffer_float`, `EXT_float_blend`,
  `OES_texture_float_linear` all present → **HDR float render targets work**.
  `MAX_TEXTURE_SIZE` = 8192. Renderer: `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))`.
- **Backend selection is rasteriser-aware, and the rule is asserted against measurement**
  (not hard-coded): WebGPU if a hardware adapter exists → WebGL2 if GL is hardware
  accelerated → **Canvas2D when GL is a software rasteriser** → WebGL2 only if there is
  no Canvas2D. `tests/render.html` fails if the chosen backend is not the measured-faster
  one on the machine it runs on, so the rule cannot silently rot.

### The backend question was answered wrong twice. Both times it was the benchmark.

| # | Claim | Number | Why it was wrong |
|---|---|---|---|
| 1 | "Canvas2D is 17.6× faster on software GL" | 156 ms/frame for GL | A shader was failing to compile (`half` is reserved in GLSL ES) and silently falling back to a CPU `readPixels` path. The measurement was of the fallback, not of GL. |
| 2 | "WebGL2 is always faster, even on software" | 3.35 ms GL vs 8.61 ms C2D | **WebGL commands are asynchronous.** Timing a 30-frame burst measures command *submission*, not execution. The queue drains later, outside the timed region. |
| 3 | **Correct** | **83.4 ms GL vs 1.22 ms C2D** | Steady state: run until two consecutive 20-frame windows agree within 12%, then time one more. Backends interleaved so JIT warm-up cannot flatter whichever runs second. |

At steady state on SwiftShader, Canvas2D is **68× faster** than WebGL2 for a 9-layer,
8-blur-pass scene. The cause is structural, not a bug: a per-pixel Gaussian in a fragment
shader is enormously more expensive under software rasterisation than Skia's optimised
`ctx.filter` blur. On real GPU hardware the ordering inverts and WebGL2 wins — which is
exactly why the rule keys on `software` rather than picking one backend globally.

Two fixes came out of this, and both matter on hardware too:

- **Blur tap count is a compile-time `#define`** (`FZ_HALF`), specialised per program.
  The loop previously ran a fixed 25 iterations with `continue` guards, so previewing at
  quality 3 cost the same as quality 25. Frame time on software GL roughly halved
  (157 → 85 ms), and preview quality is now a genuine speed dial.
- **The shape raster cache key no longer includes `time`.** Only the `noise` pattern reads
  time (`shapes.js`: `time * (speed||0)`). Hashing it unconditionally made every static
  shape miss the cache every frame and allocate a fresh canvas — 8 layers × 240 frames =
  1920 canvases, each becoming a new GPU upload source. Combined with per-layer canvas
  pooling, Canvas2D went 4.3 → 2.4 ms/frame and `rasterCacheHits` finally reports truthfully.

## 4. Performance traps

- **Every GPU/canvas timing in this project must reach steady state.** Both Canvas2D
  (`ctx.filter`) and WebGL (command buffer) record work instead of doing it, so a short
  burst reads as ~0 ms or as submission-only time. Warm until the per-window time plateaus,
  then measure — and interleave backends when comparing them.
- `createImageBitmap(canvas)` at 900×600 = **110.3 ms** → forbidden in the hot path.
  Upload canvas → texture directly instead.
- **`readPixels` from an RGBA16F attachment is not reliably supported.** On SwiftShader even
  the `IMPLEMENTATION_COLOR_READ_FORMAT`/`TYPE` pair that GL itself reports raises
  `INVALID_OPERATION` (0x502) and leaves the destination buffer **zeroed**. Reading a float
  scratch target that way silently blanked any layer whose CPU-only effect followed a GPU
  one. Fix: blit through an RGBA8 target first and read that.
- `OffscreenCanvas` 2D supports web fonts (measured width > 0) and `transferControlToOffscreen`
  exists → an off-main-thread render path is viable later.
- `OffscreenCanvas` has **no `close()`** — that method belongs to `ImageBitmap`. Calling
  `canvas.close?.()` as a cleanup step is a silent no-op; pool and reuse instead.

## 5. Alpha convention

The GL pipeline is **premultiplied end to end**: `premultipliedAlpha: true`,
`UNPACK_PREMULTIPLY_ALPHA_WEBGL: true`, blend func `(ONE, ONE_MINUS_SRC_ALPHA)`.
Using `SRC_ALPHA` as the source factor multiplies alpha in twice and darkens every
semi-transparent edge — i.e. exactly the anti-aliased glyph edges this product is about.
Effects declare their convention: the blur family reads/writes premultiplied (blurring
premultiplied colour is what prevents dark halos), everything else works on straight
colour via a `texS()` helper and re-premultiplies in `main()`. Canvas2D is straight-alpha
because that is what `getImageData`/`putImageData` use; the readback path converts.

## 6. Canvas text API surface (all supported)

`letterSpacing`, `wordSpacing`, `fontKerning`, `fontStretch`, `textRendering`, `direction`, `filter`.
`ctx.direction='rtl'` + `textAlign='right'` produces correct RTL bounding boxes.
