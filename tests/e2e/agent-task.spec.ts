// M6 — e2e: the agent loop runs end-to-end in the REAL built extension.
//
// A synthetic form page carries visible sample PII (canary-class synthetic data, §15).
// The deterministic planner must: detect → alias → fill the email and phone fields via
// LOCAL alias resolution → click Submit (which disables itself, as real forms do) →
// report completion. The raw values are asserted ONLY in the page fields (they were
// resolved locally and typed into the user's own page) — never in the panel UI.

import { expect, test } from './fixtures';
import { openTestPage } from './fixtures';

const SAMPLE_EMAIL = 'student@example.test';
const SAMPLE_PHONE = '555-123-4567';

const FORM_PAGE = `<!doctype html>
<html>
  <body>
    <h1>Registration</h1>
    <p>Use the format student@example.test or 555-123-4567 for this demo.</p>
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
  </body>
</html>`;

test('agent loop fills the form via aliases and submits', async ({ extContext, panel }) => {
  const page = await openTestPage(extContext, FORM_PAGE);

  await panel.getByPlaceholder(/fill the form/).fill('fill the form with my details and submit');
  await panel.getByRole('button', { name: 'Run agent task' }).dispatchEvent('click');

  const result = panel.getByTestId('agent-result');
  await expect(result).toBeVisible();
  await expect(result).toContainText('Task completed');
  await expect(result).toContainText('3 actions executed');

  // Alias resolution happened locally: the page fields hold the REAL sample values.
  await expect(page.locator('#email')).toHaveValue(SAMPLE_EMAIL);
  await expect(page.locator('#phone')).toHaveValue(SAMPLE_PHONE);
  expect(await page.locator('body').getAttribute('data-submitted')).toBe('true');

  // The step log is alias-level only: TYPE/CLICK entries, no raw values in the panel.
  const steps = await panel.getByTestId('agent-steps').innerText();
  expect(steps).toContain('TYPE');
  expect(steps).toContain('CLICK');
  expect(steps).not.toContain(SAMPLE_EMAIL);
  expect(panel.locator('body')).not.toContainText(SAMPLE_EMAIL);
});
