# Feature gap vs. After Effects & Premiere Pro

Research notes behind the v1.1 editing-surface work. Sources: Adobe help pages for
[time-stretching / time-remapping](https://helpx.adobe.com/after-effects/using/time-stretching-time-remapping.html),
the [AE features summary](https://helpx.adobe.com/after-effects/desktop/using/whats-new/2023.html),
[Lumetri Scopes](https://helpx.adobe.com/premiere/desktop/correct-color/add-color-effects/available-lumetri-scopes.html)
and Premiere's [Lumetri Scopes display guide](https://helpx.adobe.com/premiere-pro/using/lumetri-scopes.html)
(trim / speed / transition feature lists come from the same helpx navigation tree).

Legend: ✅ shipped · 🟡 partial · ⛔ not built (roadmap or out of scope for a browser engine).

## Compositing & layer semantics (After Effects core)

| Capability | AE | FrameZero |
|---|---|---|
| Layer stack, in/out points, opacity, blend modes | ✅ | ✅ |
| Masks (add/subtract/intersect, feather, invert) | ✅ | ✅ |
| Track mattes (alpha + luma) | ✅ | ✅ |
| **Adjustment layer** — effects grade the composite below | ✅ | ✅ v1.1 (`layer.adjustment`, compositor snapshot → chain → present) |
| **Time remap / time stretch** (rate, reverse, freeze) | ✅ | ✅ v1.1 (`layer.speed`; content clock remaps, keys stay on comp time) |
| **Boundary transitions** (cross dissolve, wipes, slides) | ✅ (via presets) | ✅ v1.1 (`layer.transition.in/out`, Premiere-style set) |
| Graph editor (value + speed graphs) | ✅ | ✅ node/curve lens |
| Keyframe interpolation + easing catalog | ✅ | ✅ |
| Text animators (per-glyph range selectors) | ✅ | ✅ |
| Variable-font axis animation | 🟡 | ✅ |
| Shape layers (rect/ellipse/polygon/star/gradients/noise) | ✅ | ✅ + icon-grid picker |
| Pre-compose / nesting with essential properties | ✅ | ⛔ roadmap |
| 3D camera, lights, depth-of-field | ✅ | ⛔ out of scope for 2D engine |
| Roto brush / content-aware fill (ML) | ✅ | ⛔ out of scope |
| Motion tracking / stabilisation | ✅ | ⛔ roadmap |
| Expressions | ✅ | ⛔ roadmap (sandboxed subset planned) |
| **Markers** (comp-level, coloured, labelled) | ✅ | ✅ v1.1 (M / Shift+M / Shift+, / Shift+.) |

## Editing & monitoring (Premiere Pro core)

| Capability | Premiere | FrameZero |
|---|---|---|
| Timeline zoom/scroll, snap, auto-key | ✅ | ✅ |
| Ripple / roll / slip / slide trim tools | ✅ | ⛔ roadmap (layer-based timeline, not clip tracks) |
| Rate stretch tool | ✅ | ✅ v1.1 (Speed × + Reverse in inspector) |
| **Lumetri-style scopes** (waveform, histogram, vectorscope) | ✅ | ✅ v1.1 Scopes tab, 8 Hz live readback |
| Safe areas / guides overlay | ✅ | ✅ v1.1 (title/action safe + thirds grid) |
| Video transitions on clip edges | ✅ | ✅ v1.1 per-layer in/out transitions |
| Audio: volume, mute, waveform envelopes | ✅ | ✅ (peaks envelope, mix per layer) |
| Multicam / J-K-L trimming | ✅ | ⛔ out of scope |
| Text-based editing (transcripts) | ✅ | ⛔ out of scope |

## v1.1 icon & chrome overhaul

Every glyph that used to stand in for an icon (effect-category `◌ ◐ ✦ ≈ ◧ ▦`,
shape kinds `■ ▭ ◯ △ ⬠ ★ ╱ ▨  ▚ ▓`, keyframe `◆`, zoom `− ＋ ⌖`) is now a
hand-drawn inline SVG from the single set in `public/js/ui/icons.js`
(~110 icons, 24×24 grid, 1.7 stroke, `currentColor`). The chrome regression
test (`no emoji left anywhere in the chrome`) fails the suite if a glyph
creeps back in.
