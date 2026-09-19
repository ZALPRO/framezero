# Security policy

## Supported versions

| Version | Supported |
|---|---|
| `v1.1.x` (current tag) | ✅ security fixes |
| `v1.0.x` | ❌ end of life — upgrade to v1.1 |
| `main` branch | ✅ best-effort, moves fast |

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

- Open a **private security advisory** on this repository
  (GitHub → Security → Advisories → New draft advisory), or email the
  maintainer address listed on the GitHub profile if advisory access is
  unavailable. Include:
  - a description of the issue and the affected version/tag,
  - minimal reproduction steps or a proof-of-concept,
  - the impact you see (client-side, server-side, supply chain).
- You will get an acknowledgement within **72 hours** and a triage decision
  (fix / mitigate / decline-with-reasons) within **7 days**.
- Coordinated disclosure: we prepare a patched tag and release notes, then you
  publish your write-up. Credit is given unless you ask otherwise.

## Threat model in one paragraph

FrameZero ships as static files plus a dependency-free Node static server;
the editor runs entirely in the browser. The realistic attack surface is
therefore: (1) malicious **project files** (JSON) opened by a victim, (2)
malicious **media assets** decoded at import, and (3) the export path
(MediaRecorder / blob URLs). Project deserialization is written to be
corruption-repairing and never evaluates embedded code — no `eval`, no
`Function`, no inline event handlers in the product path; expressions on the
roadmap will run in a sandboxed subset, not raw JS. The static server binds
`0.0.0.0` by design for container/preview use and serves only the repository's
`public/` tree with no write endpoints.

## Out of scope

- Issues requiring a compromised browser or OS.
- Self-XSS in your own project's text layers.
- Denial of service by opening absurdly large project files locally.
- Anything in `node_modules` (dev-only: Playwright) that does not affect
  shipped artifacts.
