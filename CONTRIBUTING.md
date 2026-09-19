# Contributing to FrameZero

Thanks for spending time on this — the project is small enough that one good
pull request visibly moves it. This document is the whole onboarding: house
rules, workflow, and the bar changes are held to.

## House rules (the short list that gets PRs merged)

1. **The gate is the contract.** `npm run gate` must exit 0 before you ask for
   review. It runs module syntax, release hygiene, the CSS audit, three
   headless suites and the browser smoke suite (478 checks). A red gate is a
   broken build, not a discussion.
2. **Tests before features, with features.** New engine behaviour lands with a
   pixel or model assertion in `public/tests/` (engine) or `tools/smoke.mjs`
   (product). Tests that cannot fail are worse than no tests — assert
   quantities with tolerances, not `truthy`.
3. **Two backends or it didn't happen.** Anything touching
   `public/js/render/` must produce identical results on WebGL2 and Canvas2D;
   add a parity band to the render suite for new effects/paths.
4. **English prose, everywhere.** Comments, docs, commit messages, test names.
   Persian (or any script) appears only as *product content*: demo project
   text, RTL test fixtures, codepoint tables. `tools/hygiene.mjs` enforces
   this automatically.
5. **Icons come from the one set.** New UI glyphs are added to
   `public/js/ui/icons.js` (24×24 grid, 1.7 stroke, `currentColor`). No emoji,
   no Unicode stand-ins, no icon fonts — the smoke suite regexp-scans the
   chrome for them.
6. **No runtime dependencies.** The product is plain ES modules served
   statically. Playwright stays a devDependency for tests and tooling.
7. **Honest numbers.** Performance claims carry measurement method and
   environment (see `STATUS.md`). Never benchmark GL by command-queue time;
   use a readback sync-point.

## Workflow

```bash
git checkout -b feat/short-name      # or fix/…, docs/…
npm ci && npm start                  # localhost:4173
# …change, test, repeat…
npm run gate                         # all green
git commit -m "area: imperative summary"   # e.g. "render: cache clocked chains"
git push -u origin feat/short-name   # open a PR against main
```

Commit messages: lowercase imperative subject prefixed by area
(`render`, `document`, `typography`, `ui`, `tools`, `docs`, `tests`), body
explains *why*. CI runs the gate on every push and PR; a PR that stays red is
closed after a week.

## Where things live

| You want to touch | Start at |
|---|---|
| Document model / resolver | `public/js/core/document.js` (+ `public/tests/document.html`) |
| Rendering, effects, backends | `public/js/render/*` (+ `public/tests/render.html`) |
| Typography & shaping | `public/js/render/typography.js`, `public/js/core/fonts.js` |
| Panels, inspector, timeline UI | `public/js/ui/panels.js`, `public/js/app.js` |
| Icons & chrome identity | `public/js/ui/icons.js`, `public/css/app.css` |
| Tests & gate | `tools/test.mjs`, `tools/smoke.mjs`, `tools/hygiene.mjs` |
| Demo piece | `public/projects/persian-epic.fz.json` |

## Good first contributions

- A new effect (registry entry + GLSL + Canvas2D path + parity band).
- Timeline ergonomics (trim handles, snap targets) with smoke assertions.
- Docs: measured performance tables for a GPU class we don't have yet.
- Accessibility passes: focus order, ARIA labels on the icon toolbar.

## Attribution

Third-party assets (fonts, music, paintings) must be OFL / public domain /
CC-BY with attribution recorded in `NOTICE.md` **in the same commit** that
adds the asset. No unlicensed material, ever.

## Conduct

Be excellent to each other — see
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Security issues go through
[`SECURITY.md`](SECURITY.md), not the public issue tracker.
