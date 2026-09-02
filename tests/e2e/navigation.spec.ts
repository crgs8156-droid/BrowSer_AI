// M7 — e2e: allowlisted navigation inside a multi-step task (blueprint §8 NAVIGATE).
//
// The agent starts on portal.test (a landing page with planted values and NO form) and
// the task names privagent.test. The deterministic planner may emit exactly one
// NAVIGATE — only to an origin the LOCAL policy allowlists (set via storage; default
// empty) — then continues on the target page: fill via locally-resolved aliases and
// submit. The page origin crossing the boundary is origin-only (never the full URL).

import { expect, test } from './fixtures';

const CANARY_EMAIL = 'BENCH_EMAIL_023@example.test';
const CANARY_PHONE = '555-010-0023';

const LANDING = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <h1>Portal</h1>
  <p>Checkout moved — open privagent.test to continue. Contact ${CANARY_EMAIL} · Phone ${CANARY_PHONE}</p>
</body></html>`;

const FORM = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <p>Checkout — Contact ${CANARY_EMAIL} · Phone ${CANARY_PHONE}</p>
  <form>
    <label for="email">Email</label>
    <input id="email" type="email" placeholder="Email">
    <label for="phone">Phone</label>
    <input id="phone" type="tel" placeholder="Phone">
    <button id="submit" type="button">Submit</button>
  </form>
  <script>
    document.getElementById('submit').addEventListener('click', () => {
      document.body.dataset.submitted = 'true';
      document.getElementById('submit').disabled = true;
    });
  </script>
</body></html>`;

test('agent navigates to the allowlisted origin, then fills and submits the form', async ({
  extContext,
  panel,
}) => {
  await extContext.route('https://portal.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: LANDING }),
  );
  await extContext.route('https://privagent.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: FORM }),
  );

  // The NAVIGATE allowlist is user configuration (storage); empty by default.
  await panel.evaluate(() =>
    chrome.storage.sync.set({ navigationAllowlist: ['https://privagent.test'] }),
  );

  const tab = await extContext.newPage();
  await tab.goto('https://portal.test/start');
  await tab.bringToFront();

  await panel
    .getByPlaceholder(/fill the form/)
    .fill('open privagent.test and fill the form with my details and submit');
  await tab.bringToFront();
  // The Gemini toggle defaults ON (demo mode); e2e runs offline, so select the
  // deterministic planner explicitly.
  await panel.getByTestId('use-gemini').uncheck();
  await panel.getByRole('button', { name: 'Run agent task' }).dispatchEvent('click');

  const result = panel.getByTestId('agent-result');
  await expect(result).toContainText('Task completed', { timeout: 30_000 });

  const steps = await panel.getByTestId('agent-steps').innerText();
  expect(steps).toContain('NAVIGATE');

  expect(tab.url()).toContain('privagent.test');
  await expect(tab.locator('#email')).toHaveValue(CANARY_EMAIL);
  await expect(tab.locator('#phone')).toHaveValue(CANARY_PHONE);
  expect(await tab.locator('body').getAttribute('data-submitted')).toBe('true');

  // The dashboard stays value-free across the navigation.
  const telemetryText = await panel.getByTestId('telemetry').innerText();
  expect(telemetryText).not.toContain(CANARY_EMAIL);
});
