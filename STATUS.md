# FrameZero — project status

Living engineering record. Everything below is current as of the v1.1.0 tag.
The product is public-release ready: `npm ci && npm start`, no build step,
no runtime dependencies.

## What ships

- **Editor shell** — layers / assets / effects / fonts panels, inspector with
  keyframed properties, node-graph & value-curve lenses over the same scene
  graph, command palette, keyboard-first workflow, full SVG icon set
  (`public/js/ui/icons.js`, ~110 icons on a 24×24 / 1.7-stroke grid).
- **Document model** (`public/js/core/document.js`) — project/comp/layers with
  undo-redo, corruption-repairing deserialisation, keyframe tracks with an
  easing catalogue, masks (add/subtract/intersect + feather/invert), alpha &
  luma track mattes.
- **Render engine** (`public/js/render/*`) — one scene graph, two complete
  backends (WebGL2 primary, Canvas2D fallback) held to pixel parity by the
  test gate; raster cache, effect-chain cache, proxy scaling, draft/exact
  modes, honest frame-time HUD.
- **Typography** (`public/js/render/typography.js`, `public/js/core/fonts.js`) —
  variable-font axis control, per-glyph animators, RTL/Persian shaping-safe
  layout, Font Clearance Report (per-font glyph-coverage audit).
- **v1.1 editing surface** — adjustment layers, time remap (rate + reverse),
  boundary transitions (cross / wipeL / wipeR / slideL / slideR), comp markers
  (M, Shift+M, Shift+, , Shift+.), Lumetri-style scopes (waveform, histogram,
  vectorscope), safe-area & thirds overlays. Parity matrix vs. After Effects
  and Premiere Pro: `docs/FEATURE-GAP.md`.
- **Export** — real WebM (VP9+Opus) through MediaRecorder on the viewport
  stream plus master audio (`tools/export-demo.mjs` records the shipped demo
  through this product path), PNG frame export, project JSON save/open.
- **Release engineering** — README, LICENSE, NOTICE (font/music/painting
  attributions), CI workflow, brand kit (`public/brand/`), docs/.
  Tags: `v1.0.0` (studio), `v1.1.0` (editing surface).

## Test gate

`npm run gate` = syntax audit + CSS audit + three headless suites + browser
smoke suite. Current counts: **app 117 · render 134 · document 119 ·
typography 108** assertions, zero failures; CSS audit reports 0 missing
classes. Notable regression guards:

- `no emoji left anywhere in the chrome` — fails if a Unicode glyph is ever
  used as an icon again.
- Backend parity bands (WebGL2 vs Canvas2D) on blur/bloom/blend/matte paths.
- Pixel-signature checks on every scene of the shipped 30 s reference piece
  (`tools/smoke.mjs`, section 17).
- gl2 parity for adjustment layers, wipes and cross dissolves.

## Performance work log (highlights)

- Canvas2D effect-chain output cache: static chains on unchanged rasters run
  once; keys carry raster revision, matte revision and half-pixel-quantised
  params so keyed focus pulls stay cached in 0.5 px buckets. Clocked chains
  (grain / turbulence / glitch) never cache.
- Text rasters no longer hash comp time when no animators exist (the trap the
  shape branch already avoided) — static type stopped re-rasterising per frame.
- `gaussianBlur` Canvas2D uses a downsample pyramid above radius 6; the exact
  CSS-filter path remains for radius ≤ 6, which is what parity tests exercise.
- Exporter pre-warms every scene (0.125 s steps) before MediaRecorder starts,
  and the transport tracks the wall clock while recording so a slow software
  frame can never stretch the piece.
- Layout: the timeline canvas' intrinsic width (duration × px/s) used to
  propagate into the page grid and blow the centre column to ~3300 px on long
  comps; `#main`/`#timeline` are now `min-width: 0`.

## Repository hygiene

- No debug scaffolding ships: one-off probe and debug scripts were removed
  at v1.1 cleanup; kept tooling is `smoke`, `test`, `summarize`, `export-demo`,
  `cssaudit`, `syntax.sh`, `brand`, `uishot`, `shot`, `diag`, `fontinfo.py`,
  `brush.mjs`, `measure.mjs`, `net.mjs`, `instantiate.py`.
- Persian text appears only where it *is* the product: the reference demo
  project (`public/projects/persian-epic.fz.json`), the default project's RTL
  showcase layer, and shaping test fixtures. All prose, comments and docs are
  English.
- Binary artefacts (`exports/`, `test-results/`, `.fontcache/`) are gitignored.

## Publishing

The repository is complete locally; pushing is the owner's step (needs GitHub
SSH credentials outside this sandbox):

```
git remote add origin git@github.com:<USER>/framezero.git
git push -u origin main --tags
```

## Roadmap

Precomps with essential properties · sandboxed expressions · offline render
queue with H.264/mp4 · WebGPU backend · ripple/roll/slip trim tools · waveform
editing (trim/crossfade) · audio effects · image sequences · preset library ·
motion tracking · multi-user collaboration.
