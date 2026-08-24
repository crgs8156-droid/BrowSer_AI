# PrivAgent

Privacy-preserving AI browser agent (SIH 2026). PrivAgent lets a browser agent act on
your behalf while ensuring **raw sensitive values never leave the device**: on-device
perception + PII detection, local aliasing (`USER_EMAIL_1`), a local vault, and a
fail-closed **privacy firewall** as the single outbound boundary.

> **Status:** M0 (scaffolding) complete. No detection/OCR/ML/sanitization/vault/agent/
> firewall logic is implemented yet — modules are typed stubs. See
> [PROJECT_STATUS.md](PROJECT_STATUS.md).

## Prerequisites

- Node.js (project pins TypeScript to 5.9.3 for lint-tooling compatibility)
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
# Windows: source venv/Scripts/activate   |  macOS/Linux: source venv/bin/activate
pip install -r requirements.txt
```

## Scripts

| Command             | What it does                                    |
| ------------------- | ----------------------------------------------- |
| `npm run dev`       | Vite dev build of the extension                 |
| `npm run build`     | `tsc --noEmit` typecheck, then production build |
| `npm run typecheck` | Typecheck only                                  |
| `npm run lint`      | ESLint (flat config)                            |
| `npm run format`    | Prettier write                                  |
| `npm test`          | Vitest unit/integration tests                   |
| `npm run e2e`       | Playwright browser tests                        |

Load the built extension from `dist/` via `chrome://extensions` → _Load unpacked_.

## Layout

```
extension/        MV3 extension (background, content, sidepanel, offscreen, modules)
backend/fastapi/  local support service (health; leakage sink + benchmark later)
docs/             architecture, threat model, interface contracts
tests/            unit / integration / e2e
models/           on-device model artifacts (git-ignored)
benchmark/        eval pages, tasks, canaries, reports (git-ignored outputs)
```

## Security

Design invariants live in [CLAUDE.md](CLAUDE.md) and [docs/threat-model.md](docs/threat-model.md).
The short version: protected values and alias↔value mappings stay local; the firewall
is the only egress and fails closed; webpage content is untrusted; the agent emits only
structured actions (`CLICK/TYPE/SELECT/SCROLL/NAVIGATE`) — never arbitrary code.
