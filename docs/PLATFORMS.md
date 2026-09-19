# Running FrameZero on your platform

FrameZero is a static ES-module app plus a tiny Node server, so "installing"
it means: a modern Node runtime, `npm ci`, `npm start`. Everything below was
verified on the versions in parentheses; newer is fine.

| Platform | Status | Notes |
|---|---|---|
| macOS 13+ (Apple Silicon & Intel) | ✅ supported | Native, no Rosetta needed |
| Linux (Debian 12 / Ubuntu 22.04+, Fedora 39+) | ✅ supported | Headless tests need a few system libs (one command, below) |
| Windows 11 | ✅ via WSL2 | Follow the Linux guide inside WSL2; native Windows is untested |
| ChromeOS / BSD | 🟡 likely | Untested; the app itself only needs a modern browser |

Requirements: **Node ≥ 20** (ES modules, `node --check`), **npm ≥ 10**, and a
Chromium-class browser for the product (Chrome/Edge/Brave/Opera). The only npm
dependency in the lockfile is Playwright, used by tests and shot tooling — the
shipped product has zero runtime dependencies.

---

## macOS

```bash
# 1. Node (Homebrew). Already have Node 20+? Skip this line.
brew install node

# 2. Get the code and its dev dependency
git clone https://github.com/ZALPRO/framezero.git
cd framezero
npm ci

# 3. Run it
npm start                 # → http://localhost:4173  (PORT=8080 npm start to move it)

# 4. Tests (headless Chromium; macOS needs no extra system packages)
npx playwright install chromium
npm run gate
```

Apple Silicon runs natively; the WebGL2 path uses Metal through Chrome, and
the Canvas2D fallback is exercised by the parity tests either way.

## Linux (Debian / Ubuntu)

```bash
# 1. Node 20 (NodeSource) — or your distro's equivalent
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Get the code
git clone https://github.com/ZALPRO/framezero.git
cd framezero
npm ci

# 3. Run it
npm start                 # → http://localhost:4173

# 4. Tests: headless Chromium needs system libraries — this installs them
npx playwright install --with-deps chromium
npm run gate
```

`--with-deps` pulls the usual headless set (`libnspr4`, `libnss3`,
`libasound2`, `libatk-bridge2.0-0`, …). On Fedora the equivalent is
`sudo dnf install nspr nss alsa-lib at-spi2-atk` followed by
`npx playwright install chromium`.

Software-GL machines (VMs, CI, servers without a GPU) are first-class: the
app detects the missing GPU, reports `Canvas 2D · software` in the header and
stays usable via draft mode + proxy scaling. The test gate runs entirely on
software rasterisation in CI.

## Windows 11 (WSL2)

```powershell
wsl --install            # once, from an admin shell; reboot
```

Then follow the **Linux** guide inside the WSL2 shell. Serve from the Linux
filesystem (`~/framezero`, not `/mnt/c/...`) for sane file-watch and I/O
performance. Open the app in Windows Chrome at `http://localhost:4173` —
WSL2 forwards localhost automatically.

---

## Verifying your install

| Check | Command | Expect |
|---|---|---|
| Server boots | `npm start` | `FrameZero server → http://0.0.0.0:4173` |
| Syntax + hygiene | `npm run test:syntax` | `HYGIENE OK` |
| CSS audit | `npm run test:css` | `missing from app.css: 0` |
| Headless suites | `npm test` | three suites, `fail 0` each |
| Product in a browser | `npm run test:smoke` | `ALL PASS — 117 passed` |
| All of the above | `npm run gate` | exit code 0 |

## Troubleshooting

- **`error while loading shared libraries: libnspr4.so`** — headless Chromium
  is missing system libs. Re-run `npx playwright install --with-deps chromium`
  (Linux only).
- **Port already in use** — `PORT=5050 npm start`; the server honours `PORT`
  and binds `0.0.0.0` so containers and port-forwards work.
- **Fonts look wrong in exports** — the app bundles its five families and
  loads them through the FontFace API; nothing to install system-wide. If a
  *custom* imported font misses Persian glyphs, the in-app Font Clearance
  Report tells you exactly which codepoints are uncovered.
- **`npm ci` fails on a dirty lockfile** — delete `node_modules` and re-run
  `npm ci`; the lockfile is the source of truth (Playwright is the only entry).
- **CI vs local differences** — `.github/workflows/ci.yml` runs the same gate
  on `ubuntu-latest` with Node 20; if it passes there and not locally, compare
  Node versions first (`node -v`).

## Publishing your own fork

```bash
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main --tags
```

The release tags (`v1.0.0`, `v1.1.0`, …) carry annotated messages; GitHub Actions runs the gate on every push and pull request.
