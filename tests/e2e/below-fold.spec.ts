// M7 — e2e: the planner scrolls to below-fold controls, then completes the task.
//
// The planted values are visible at the top, the FORM sits ~1200px down: the first
// observations report the controls as belowFold, so the deterministic planner must emit
// bounded SCROLL steps until they are in view, then TYPE/CLICK as usual. Repeated
// scrolls are exempt from the no-progress guard (scrolling IS progress-seeking); the
// step budget still bounds them.

import { expect, test } from './fixtures';
import { openTestPage } from './fixtures';

const CANARY_EMAIL = 'BENCH_EMAIL_022@example.test';
const CANARY_PHONE = '555-010-0022';

const TALL_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
  <p>Registration — Name: Bench User One · Contact ${CANARY_EMAIL} · Phone ${CANARY_PHONE}</p>
  <div style="height:1200px"></div>
  <form>
    <label for="name">Full name</label>
    <input id="name" type="text" placeholder="Full name">
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

test('agent scrolls to below-fold fields and completes the task', async ({
  extContext,
  panel,
}) => {
  const tab = await openTestPage(extContext, TALL_PAGE);

  await panel.getByPlaceholder(/fill the form/).fill('fill the form with my details and submit');
  await tab.bringToFront();
  await panel.getByRole('button', { name: 'Run agent task' }).dispatchEvent('click');

  const result = panel.getByTestId('agent-result');
  await expect(result).toContainText('Task completed', { timeout: 30_000 });

  const steps = await panel.getByTestId('agent-steps').innerText();
  expect(steps).toContain('SCROLL');

  // Alias resolution happened locally: the below-fold fields hold the real values.
  await expect(tab.locator('#name')).toHaveValue('Bench User One');
  await expect(tab.locator('#email')).toHaveValue(CANARY_EMAIL);
  await expect(tab.locator('#phone')).toHaveValue(CANARY_PHONE);
  expect(await tab.locator('body').getAttribute('data-submitted')).toBe('true');
});
