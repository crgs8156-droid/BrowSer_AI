# PrivAgent — 5-minute demonstration script (blueprint §15, adapted to M7)

Every step below maps to something that exists and is tested. Synthetic data only
(blueprint §15 rule: never real personal data). Rehearse with a fresh `npm run build`
and the unpacked `dist/` loaded from `chrome://extensions`.

## Setup (before the timer)

1. `npm run build` → load `dist/` unpacked.
2. Serve the benchmark form pages: `npx serve benchmark` is NOT needed — open any of
   the synthetic form pages used by the e2e suite (see
   `tests/e2e/bench-tasks.spec.ts` for the exact HTML), or any page with a form.
3. Have `benchmark/reports/latest.md` open in a second window.

## Script

| Time | Demo moment | What you actually do | Judge takeaway |
| --- | --- | --- | --- |
| 0:00–0:30 | The problem: an AI agent normally sees everything on the page. | Talk over a normal autofilled form: the agent's context would contain the raw email, phone, card. | Problem is clear. |
| 0:30–1:00 | Realistic synthetic form. | Open the registration-style page (name/email/phone). | Realistic use case. |
| 1:00–1:30 | Local detection + sanitization. | Click **Scan Page** in the PrivAgent side panel → show the sanitized summary: sensitive counts, `USER_EMAIL_1`-style aliases, no raw values in the UI. | Perception works, locally. |
| 1:30–2:00 | The alias mechanism. | Emphasize: the mapping alias→real value lives ONLY in the in-memory vault — wiped on session end, never persisted, never logged (canary-tested). | Novel privacy mechanism. |
| 2:00–3:00 | The agent completes the task on sanitized context. | Type *"fill the form with my details and submit"* into the **Agent task** box, click **Run agent task**. The step log shows `TYPE (#email) → executed`, `CLICK (#submit) → executed` — the form fills with the REAL values resolved locally at execution time, and the page reports submission. | Utility is preserved. |
| 3:00–4:00 | Privacy is measured, not claimed. | Show the leakage sentinel: benchmark canaries (`BENCH_*`) searched in every outbound request and step record — **leakage rate 0%**; credential-bearing pages are fail-closed blocked with **0 bytes** transmitted. | Measured security claim. |
| 4:00–4:30 | The trade-off. | Show the §11 comparison table: full redaction destroys **all** fillable slots; PrivAgent preserves **all** slots at comparable payload size. | PrivAgent solves the privacy–utility problem. |
| 4:30–5:00 | Benchmark + architecture. | Show `benchmark/reports/latest.md` (recall 100%, false positives 0%, task success 100%, per-stage latency) and the one-diagram architecture (single egress through the firewall). | Research + engineering maturity. |

## Recommended closing line (blueprint §15)

> "An AI agent should be able to act on your behalf without needing to know who you are."

## Fallbacks

- If a scan reports `Restricted page` on a `chrome://` page: that IS the product
  failing closed — say so and open a normal page.
- If the agent task stops with `⛔ Blocked`: the page carried a critical credential —
  the fail-closed gate; demo it on a page WITHOUT a visible password/token.
- Network-independent: the deterministic planner runs fully on-device, so the demo
  works with no internet.
