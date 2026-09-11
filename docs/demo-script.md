# PrivAgent — 3-minute demonstration script (M10)

Every step below maps to verified extension behavior (vitest + e2e green).
Synthetic data only — never real personal data. Rehearse with a fresh
`npm run build` and the unpacked `dist/` loaded from `chrome://extensions`.
Default planner for the demo: **Offline (deterministic)** — no backend, no key,
no network. (Gemini/Ollama modes use the same sanitized contract.)

## Minute 1 — Problem, privacy status, one task

1. Open the side panel on any ordinary form page. The **Scan** section shows the
   privacy status: sensitive counts with `USER_EMAIL_1`-style aliases, never raw
   values (leakage sentinel: 0%). Open **Scan Details** to see the masked table (e.g. `test@•••.com`, `+91 98•••••210` for Indian mobiles, Aadhaar/PAN masked) — never full values.
2. In **Agent task**, click a template chip if one fits (e.g. Login), or type one
   instruction, e.g. "go to ilovepdf, log in, compress a PDF".
3. Click **Run agent task**. The step log opens with "Scanning page...",
   "Shielding fields (local)...", "Planning action...".

## Minute 2 — Live execution with approval

4. The step log appends in real time (`TYPE on #email`, `CLICK on #submit` —
   alias-level targets only; TYPE values are never rendered).
5. Cross-site navigation triggers the approval dialog: "Agent wants to navigate
   to {origin} — allow? [Yes/No]". Click **Allow** — the origin joins the
   session allowlist; without approval the loop stops fail-closed.
6. The agent fills the login form (resolved locally at execution time),
   "0 BYTES LEAKED" holds throughout, login completes, and the loop continues
   on the new page automatically (same-origin needs no approval).
7. If a CAPTCHA appears, the loop pauses with a yellow banner (expected
   behavior, not an error) — solve it manually, click **Resume**.

## Minute 3 — Proof: audit log and report

8. Open the **Telemetry** section → **Session Log**: timestamped entries for
   every detection, alias, action, navigation, and block of the run.
9. Click **Export Report** → `privagent-report-{date}.json` downloads, toast
   confirms "0 raw values included".
10. Open the JSON: `bytesLeaked: 0`, protected categories listed, audit trail
    attached, disclaimer "Raw values were never stored".

> "Raw values never left this machine."

## Fallbacks (all are the product working as designed)

- `Restricted page` on `chrome://`/PDFs: fail-closed — open a normal page.
- `Blocked`: the page carried an unenforceable finding — demo on a clean page.
- `NAVIGATE_NEEDS_APPROVAL`: the allowlist gate held — approve or stay.
- CAPTCHA banner: solve + Resume; error pages stop with an origin-only reason.
