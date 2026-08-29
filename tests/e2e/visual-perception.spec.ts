// M3 E2E — visual perception driven through the real production path:
//   side panel button → chrome.runtime.sendMessage → background worker →
//   chrome.scripting.executeScript → real page DOM → snapshot → local pipeline.
//
// Pages under test are synthetic and served locally by Playwright routing (no real
// network, no real personal data), but Chrome still sees genuine https:// documents
// with real layout, so getBoundingClientRect/computed styles are real.

import { COLLECT_VISUAL_CANDIDATES, type VisualCandidatesResponse } from '../../extension/src/types/messages';
import { expect, openTestPage, runVisualCheck, statusLine, test, TEST_ORIGIN } from './fixtures';

/** Long enough to clear SPARSE_DOM_TEXT_CHARS, with a described canvas. */
const TEXT_RICH_DESCRIBED = `<!doctype html>
<html><body>
  <h1>Synthetic article</h1>
  <p>${'This paragraph exists purely to give the DOM plenty of readable text. '.repeat(6)}</p>
  <canvas id="chart" width="400" height="300" aria-label="Quarterly revenue chart"></canvas>
</body></html>`;

/** No img/canvas/video/svg/iframe at all. */
const TEXT_ONLY = `<!doctype html>
<html><body>
  <h1>Plain text page</h1>
  <p>${'Nothing here is painted; everything is DOM text. '.repeat(6)}</p>
</body></html>`;

/** Sparse DOM text plus a large undescribed painted surface. */
const CANVAS_APP = `<!doctype html>
<html><body style="margin:0">
  <canvas id="app" width="800" height="600"></canvas>
  <script>
    const ctx = document.getElementById('app').getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 800, 600);
    ctx.fillStyle = '#111';
    // Synthetic glyph-like rows: no real text is drawn.
    for (let y = 20; y < 560; y += 16) {
      for (let x = 20; x < 760; x += 7) ctx.fillRect(x, y, 4, 9);
    }
  </script>
</body></html>`;

test.describe('DOM-first: visual work is skipped when the DOM suffices', () => {
  test('reports not required when a painted region is already described', async ({
    extContext,
    panel,
  }) => {
    await openTestPage(extContext, TEXT_RICH_DESCRIBED);
    await runVisualCheck(panel);

    await expect(statusLine(panel)).toHaveText('Not required — DOM was sufficient');
    await expect(panel.getByText('Reason: dom_sufficient')).toBeVisible();
  });

  test('reports not required when the page paints nothing', async ({ extContext, panel }) => {
    await openTestPage(extContext, TEXT_ONLY);
    await runVisualCheck(panel);

    await expect(statusLine(panel)).toHaveText('Not required — DOM was sufficient');
    await expect(panel.getByText('Reason: no_visual_candidates')).toBeVisible();
  });
});

test.describe('content-driven: work happens for undescribed painted content', () => {
  test('does not skip a large undescribed canvas', async ({ extContext, panel }) => {
    await openTestPage(extContext, CANVAS_APP);
    await runVisualCheck(panel);

    const status = await statusLine(panel).textContent();

    // The decision must have called for visual work. Whether it then completes
    // depends on whether this profile grants tabs.captureVisibleTab — an
    // environment fact, not a logic difference — so both outcomes are accepted,
    // but "not required" is not.
    expect(status).not.toBe('Not required — DOM was sufficient');
    expect(['Completed', 'Unavailable in this context']).toContain(status);
  });
});

test.describe('browser restrictions are reported, never bypassed', () => {
  test('reports a restricted page for a non-web active tab', async ({ extContext, panel }) => {
    // The persistent context's initial tab is about:blank — a real surface where
    // extensions cannot script or capture.
    const blank = extContext.pages()[0];
    expect(blank).toBeDefined();
    await blank?.bringToFront();

    await runVisualCheck(panel);

    await expect(statusLine(panel)).toHaveText('Restricted page — browser security');
    await expect(panel.getByText('Reason: browser_security_restriction')).toBeVisible();
  });
});

test.describe('candidate collection against a real DOM', () => {
  test('returns real measured geometry for the active tab', async ({ extContext, panel }) => {
    await openTestPage(extContext, CANVAS_APP);

    const response: VisualCandidatesResponse = await panel.evaluate(
      (messageType) => chrome.runtime.sendMessage({ type: messageType }),
      COLLECT_VISUAL_CANDIDATES,
    );

    expect(response.restricted).toBeUndefined();
    const snapshot = response.snapshot;
    expect(snapshot).toBeTruthy();
    expect(snapshot?.url).toContain(TEST_ORIGIN);
    expect(snapshot?.viewport.width).toBeGreaterThan(0);

    const canvas = snapshot?.candidates.find((candidate) => candidate.kind === 'canvas');
    expect(canvas).toBeDefined();
    expect(canvas?.rect.width).toBe(800);
    expect(canvas?.rect.height).toBe(600);
    expect(canvas?.hasAccessibleText).toBe(false);
    expect(canvas?.domTextLength).toBe(0);
  });

  test('carries no pixel data across the message boundary', async ({ extContext, panel }) => {
    await openTestPage(extContext, CANVAS_APP);

    const serialized = await panel.evaluate(
      async (messageType) => JSON.stringify(await chrome.runtime.sendMessage({ type: messageType })),
      COLLECT_VISUAL_CANDIDATES,
    );

    expect(serialized).not.toMatch(/data:image/);
    expect(serialized).not.toMatch(/base64/);
  });
});

test.describe('privacy: nothing leaves the machine', () => {
  test('issues no remote request during a visual check', async ({
    extContext,
    extensionId,
    panel,
  }) => {
    await openTestPage(extContext, CANVAS_APP);

    const urls: string[] = [];
    panel.on('request', (request) => urls.push(request.url()));

    await runVisualCheck(panel);

    const remote = urls.filter(
      (url) => !url.startsWith(`chrome-extension://${extensionId}/`) && !url.startsWith('data:'),
    );
    expect(remote).toEqual([]);
  });

  test('logs no capture payload to the panel console', async ({ extContext, panel }) => {
    const logged: string[] = [];
    panel.on('console', (message) => logged.push(message.text()));

    await openTestPage(extContext, CANVAS_APP);
    await runVisualCheck(panel);

    const output = logged.join('\n');
    expect(output).not.toMatch(/data:image/);
    expect(output).not.toMatch(/base64/);
  });
});
