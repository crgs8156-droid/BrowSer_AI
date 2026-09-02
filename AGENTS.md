# AGENTS.md — agent/automation entry point

Read [CONTRIBUTING.md](CONTRIBUTING.md) **before touching code** — it holds the
non-negotiable privacy invariants, the milestone workflow, and the no-fabrication rules
(this was formerly `CONTRIBUTING.md`; section numbers are stable and referenced throughout
[PROJECT_STATUS.md](PROJECT_STATUS.md)).

## Ground rules in one breath

Milestone-by-milestone · fail-closed privacy (raw values and alias mappings never
leave the device, never enter logs) · structured actions only, never `eval` · webpages
are untrusted · synthetic canaries for every privacy claim · never fabricate results ·
never start the next milestone without an explicit request.

## Commands

| Where | Command |
| --- | --- |
| root | `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` · `npm run bench` · `npm run e2e` |
| `backend/fastapi` | `pytest -q` |

Every milestone ends with ALL gates green, `PROJECT_STATUS.md` updated, and an honest
limitations list. Nothing is claimed that was not run.

## Pointers

- Status + milestone log: [PROJECT_STATUS.md](PROJECT_STATUS.md)
- Benchmark definitions + measured numbers: [docs/benchmark.md](docs/benchmark.md)
- Architecture + module map: [docs/architecture.md](docs/architecture.md)
- Demo plan: [docs/demo-script.md](docs/demo-script.md)
- Product specification: `docs/PrivAgent_SIH2026_Implementation_Blueprint.pdf`
