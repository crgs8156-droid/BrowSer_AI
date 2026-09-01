# PrivAgent

[![ci](https://github.com/codesR-cs/BrowSer_AI/actions/workflows/ci.yml/badge.svg)](https://github.com/codesR-cs/BrowSer_AI/actions/workflows/ci.yml)

Privacy-preserving AI browser agent (SIH 2026). PrivAgent lets a browser agent act on
your behalf while ensuring **raw sensitive values never leave the device**: on-device
perception + multi-signal PII detection, local semantic aliasing (`USER_EMAIL_1`), a
local identity vault, an agent that plans structured actions over sanitized context,
and a fail-closed **privacy firewall** as the single outbound boundary.

> **Status:** M0–M7 complete (extension, perception, policy, sanitization, agent loop,
> action bridge, privacy firewall, telemetry, PrivAgent-Bench). The remote LLM provider
> adapter (Ollama) is the next milestone — the deterministic planner drives everything
> today. See [PROJECT_STATUS.md](PROJECT_STATUS.md) for the milestone log and
> [docs/benchmark.md](docs/benchmark.md) for measured results.

## The six differentiators (and their proof)

| Feature | Proof in this repo |
| --- | --- |
| 1. Local multimodal perception | DOM + local OCR (Tesseract.js, extension-local assets) + visual pipeline — [tests/integration/visual-*.test.ts](tests/integration) |
| 2. Semantic sanitization | Values become typed aliases the agent can reason about — `extension/src/sanitizer/` |
| 3. Local identity vault | Alias↔value mapping in memory only, wiped per session — `extension/src/vault/` |
| 4. Privacy firewall | Exact-shape + alias-grammar + PII-scan gate; fails closed — `extension/src/firewall/` |
| 5. Leakage sentinel | Synthetic canaries searched in every outbound payload; measured leakage rate — `benchmark/run.ts` |
| 6. Privacy–utility trade-off | §11 three-way comparison generated per page — `npm run bench` |

## Measured results (PrivAgent-Bench, fixtures v1)

| Metric | Measured |
| --- | --- |
| PII recall (25 planted items, 5 categories) | **100%** |
| False-positive rate (16 safe controls) | **0%** |
| Leakage rate (§7 sentinel, full agent runs) | **0%** |
| Task success rate (real extension, 4 families) | **100%** |
| Credential-bearing pages | fail-closed blocked, **0 bytes** transmitted |
| §11 comparison | PrivAgent preserves **all** fillable slots where full redaction preserves **0** |

All numbers are produced by `npm run bench` + `npm run e2e` — measured, not claimed.

## Prerequisites

- Node.js 22 (project pins TypeScript to 5.9.3 for lint-tooling compatibility)
- Python 3.11+ (for the backend)

## Setup

```bash
npm install
npx playwright install chromium
```

Backend:

```bash
cd backend/fastapi
python -m venv venv
# Windows: source venv/Scripts/activate   |   macOS/Linux: source venv/bin/activate
pip install -r requirements.txt
```

## Scripts

| Command             | What it does                                              |
| ------------------- | --------------------------------------------------------- |
| `npm run dev`       | Vite dev build of the extension                           |
| `npm run build`     | `tsc --noEmit` typecheck, then production build           |
| `npm run typecheck` | Typecheck only                                            |
| `npm run lint`      | ESLint (flat config)                                      |
| `npm run format`    | Prettier write                                            |
| `npm test`          | Vitest unit/integration tests                             |
| `npm run bench`     | PrivAgent-Bench → `benchmark/reports/` artifacts          |
| `npm run e2e`       | Playwright tests incl. real-extension agent task success  |

Load the built extension from `dist/` via `chrome://extensions` → _Load unpacked_.

The side panel can **Scan Page** (detection → policy → sanitized summary) and **run an
agent task** ("fill the form with my details and submit"): the agent observes the page
through sanitized aliases only, and alias→value resolution happens on-device at the
moment an action needs the value.

## Layout

```
extension/        MV3 extension (background, content, sidepanel, offscreen, modules)
backend/fastapi/  planner service: POST /v1/plan (+ /v1/act); provider seam (M-next)
docs/             architecture, threat model, interface contracts, benchmark, demo script
tests/            unit / integration / e2e (real extension via Playwright)
benchmark/        PrivAgent-Bench: fixtures, evaluation core, reports (git-ignored)
models/           on-device model artifacts (git-ignored)
```

## Security

Design invariants live in [CLAUDE.md](CLAUDE.md) and [docs/threat-model.md](docs/threat-model.md).
The short version: protected values and alias↔value mappings stay local; the firewall
is the only egress and fails closed; webpage content is untrusted; the agent emits only
structured actions (`CLICK/TYPE/SELECT/SCROLL/NAVIGATE`) — never arbitrary code; logs,
telemetry and benchmark exports never contain raw values.
