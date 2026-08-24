# PrivAgent — Architecture (M0 scaffold)

This document describes the **module boundaries** established in M0. No feature logic
exists yet; each module is a typed stub that throws until its milestone lands. See
[PROJECT_STATUS.md](../PROJECT_STATUS.md) for the milestone plan and
[docs/threat-model.md](threat-model.md) / [docs/interface-contracts.md](interface-contracts.md)
for the security design.

## Runtime surfaces (Chrome MV3)

| Surface            | Path                        | Role                                                        |
| ------------------ | --------------------------- | ----------------------------------------------------------- |
| Service worker     | `extension/src/background/` | Coordinator; opens side panel; routes messages.             |
| Content script     | `extension/src/content/`    | Reads the (untrusted) page DOM. Least-privilege host scope. |
| Side panel (React) | `extension/src/sidepanel/`  | User-facing UI.                                             |
| Offscreen document | `extension/src/offscreen/`  | Hosts WASM/DOM inference the SW cannot run (M3/M4).         |

## Core modules (typed stubs in M0)

```
perception/dom      DOM extraction                (M1)
perception/ocr      browser OCR                    (M3)
perception/vision   screenshot capture/regions    (M3)
sensitivity         rule + ML classification       (M2/M4)
sanitizer           value -> alias substitution    (M5)
vault               local alias<->value store      (M5)
agent               provider-agnostic planner      (M6)
actions             structured action validation   (M6)
firewall            single outbound boundary       (M7)
telemetry           privacy-event audit log        (M7)
types/contracts     shared data contracts          (M0)
```

## The one rule that shapes everything: single egress

All outbound network traffic to a remote model/backend passes through
**`firewall/`** and nothing else. The firewall is the last checkpoint before the
remote boundary and **fails closed** — if it cannot establish that a payload is
alias-only and free of protected values, it blocks. Raw protected values and
alias→value mappings never leave the device and are never logged (CLAUDE.md §5).

```
page DOM (untrusted)
   -> perception -> sensitivity -> sanitizer --(aliases only)--> firewall --> remote
                                        |
                                     vault (local; real values stay here)
```

## Backend

`backend/fastapi/` is a local support service (health, and later the external
leakage sink + benchmark). It is treated as a remote boundary: it must never
receive raw protected values.

## Build layout

- Vite + `@crxjs/vite-plugin` builds the MV3 bundle from `extension/manifest.ts`.
- `tsc --noEmit` typechecks; `vitest` runs unit/integration tests (Node env);
  Playwright runs browser e2e.
