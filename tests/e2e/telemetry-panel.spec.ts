// M7 — e2e: the telemetry dashboard renders real, value-free data in the panel.
//
// A scan produces DETECTED/SANITIZED events + stage timings; an agent run produces
// ALIAS_RESOLVED/TASK_RESULT + agent.* timings. The dashboard must show them — and
// must never show a raw value.

import { expect, test } from './fixtures';
import { openTestPage } from './fixtures';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <p>Registration — Contact student@example.test · Phone 555-010-0009</p>
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

test('telemetry dashboard fills from scan + agent run, never showing raw values', async ({
  extContext,
  panel,
}) => {
  const tab = await openTestPage(extContext, PAGE);

  // 1 — a scan feeds event counts + stage timings.
  await panel.getByRole('button', { name: 'Scan Page' }).dispatchEvent('click');
  await expect(panel.getByTestId('telemetry')).toContainText('DETECTED');
  await expect(panel.getByTestId('telemetry')).toContainText('SANITIZED');

  // 2 — an agent run adds alias resolutions, task result and agent.* stage timings.
  await panel.getByPlaceholder(/fill the form/).fill('fill the form with my details and submit');
  await tab.bringToFront();
  await panel.getByRole('button', { name: 'Run agent task' }).dispatchEvent('click');
  await expect(panel.getByTestId('agent-result')).toContainText('Task completed');

  const timings = panel.getByTestId('telemetry-timings');
  await expect(timings).toContainText('scan.detect');
  await expect(timings).toContainText('scan.enforce');
  await expect(timings).toContainText('agent.total');

  // 3 — the dashboard is value-free: the planted raw values never appear in it.
  const telemetryText = await panel.getByTestId('telemetry').innerText();
  expect(telemetryText).not.toContain('student@example.test');
  expect(telemetryText).not.toContain('555-010-0009');

  // 4 — reset clears everything.
  await panel.getByRole('button', { name: 'Reset' }).dispatchEvent('click');
  await expect(panel.getByTestId('telemetry')).toContainText('No telemetry yet');
});
