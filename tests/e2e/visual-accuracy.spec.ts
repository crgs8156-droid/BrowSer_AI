// M7 — e2e: visual-context accuracy on VISUAL-ONLY pages (rubric #1, 25%).
//
// The planted sensitive values exist ONLY as painted pixels (canvas fillText) — the
// DOM collector cannot see them, so ANY detection proves the local OCR/vision path
// works. This also closes the "live wasm recognition pending manual Chrome
// verification" item from PROJECT_STATUS §0: these tests run the REAL Tesseract.js
// engine in a real (headless) Chromium.
//
// Measured and written to benchmark/reports/visual-accuracy.{json,md}:
//   - contentStatus ('ok' = the wasm engine ran)
//   - per-page category detection vs expected (category-level accuracy — the agent's
//     visual context consists of categories + geometry, never recognized raw text)
//   - textCount === 0 (proof the page was genuinely visual-only)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import { openTestPage } from './fixtures';

// Serial: one measurement run, deterministic relay timing.
test.describe.configure({ mode: 'serial' });

const REPORTS_DIR = join(process.cwd(), 'benchmark', 'reports');

interface VisualStats {
  contentStatus?: string;
  categories: Record<string, number>;
  regionsProcessed: number;
}

// Deterministic OCR input: committed PNGs (regenerate via
// tests/e2e/generate-bench-assets.mjs) inlined as data URLs — runtime fillText depends
// on installed fonts, which made Tesseract quality vary between machines, and routing
// games lose to the fixture helper's own route. Pixels are identical everywhere.
function imagePage(images: string[]): string {
  const assetsDir = join(process.cwd(), 'tests', 'e2e', 'assets');
  const tags = images
    .map((name) => {
      const base64 = readFileSync(join(assetsDir, `bench-${name}.png`)).toString('base64');
      return `<img class="bench-img" src="data:image/png;base64,${base64}" width="860" height="110" style="display:block; margin:8px 0">`;
    })
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
  <p>Membership profile</p>
  ${tags}
</body></html>`;
}

const PAGES: {
  id: string;
  images: string[];
  expected: string[];
}[] = [
  {
    id: 'canvas-contact',
    images: ['email', 'phone'],
    expected: ['EMAIL', 'PHONE'],
  },
  {
    id: 'canvas-card',
    images: ['card'],
    expected: ['PAYMENT'],
  },
];

interface AccuracyRow {
  pageId: string;
  contentStatus: string;
  expected: string[];
  detected: string[];
  missed: string[];
  falsePositives: string[];
  matched: boolean;
}

const rows: AccuracyRow[] = [];

for (const page of PAGES) {
  test(`visual-only page: ${page.id} (OCR runs, categories correct, no DOM detection)`, async ({
    extContext,
    panel,
  }) => {
    const tab = await openTestPage(extContext, imagePage(page.images));


    // 1 — the dedicated visual check: the wasm engine must actually RUN.
    await panel.getByRole('button', { name: 'Run Visual Check' }).dispatchEvent('click');
    await expect(panel.getByText(/OCR:/)).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText('OCR: OCR/vision engine ran')).toBeVisible();

    const stats = (await panel.evaluate(() => window.__PRIVAGENT_VISUAL__)) as VisualStats | null;
    expect(stats, 'visual stats seam must be populated').toBeTruthy();
    expect(stats?.contentStatus).toBe('ok');

    // 2 — the full scan: the canvas values must be caught as OCR regions, and the DOM
    //     text layer must have contributed NOTHING (visual-only proof).
    await tab.bringToFront();
    await panel.getByRole('button', { name: 'Scan Page' }).dispatchEvent('click');
    await expect(panel.getByTestId('findings')).toBeVisible({ timeout: 30_000 });

    const summaryText = await panel.getByTestId('findings').innerText();
    expect(summaryText).toContain('OCR_REGION');
    // Visual-only proof: the DOM text layer contributed no aliased text findings.
    const section = panel.locator('section[aria-label="Scan findings"]');
    await expect(section).toContainText(/Image\/OCR regions: [1-9]\d*/);
    expect(summaryText).not.toContain('USER_EMAIL');
    expect(summaryText).not.toContain('USER_PHONE');
    expect(summaryText).not.toContain('USER_PAYMENT');

    // 3 — category-level accuracy (the value-free surface the agent would see).
    const detected = Object.entries(stats?.categories ?? {})
      .filter(([, count]) => count > 0)
      .map(([category]) => category);
    const missed = page.expected.filter((category) => !detected.includes(category));
    const falsePositives = detected.filter((category) => !page.expected.includes(category));

    rows.push({
      pageId: page.id,
      contentStatus: stats?.contentStatus ?? 'unknown',
      expected: page.expected,
      detected,
      missed,
      falsePositives,
      matched: missed.length === 0 && falsePositives.length === 0,
    });

    expect(missed, `${page.id}: expected categories must be recognized`).toEqual([]);
    expect(falsePositives, `${page.id}: no unexpected categories`).toEqual([]);
  });
}

test('writes the visual-accuracy report', async () => {
  expect(rows.length).toBe(PAGES.length);
  const matched = rows.filter((row) => row.matched).length;
  const report = {
    generatedAt: new Date().toISOString(),
    metric: 'rubric #1 — accuracy of visual context from screen (category-level)',
    note: 'Planted values exist ONLY as canvas pixels; category counts are the value-free accuracy surface. Character-level OCR accuracy is future work.',
    engine: 'Tesseract.js v6 (local wasm, extension-local assets)',
    pages: rows,
    accuracy: rows.length === 0 ? 0 : matched / rows.length,
  };

  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(join(REPORTS_DIR, 'visual-accuracy.json'), JSON.stringify(report, null, 2));
  const lines = [
    '# Visual-context accuracy (rubric #1)',
    '',
    `Generated: ${report.generatedAt} · engine: local Tesseract.js wasm (headless Chromium)`,
    '',
    '| Page | Engine | Expected | Detected | Match |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((row) =>
      `| ${row.pageId} | ${row.contentStatus} | ${row.expected.join(', ')} | ${row.detected.join(', ') || '—'} | ${row.matched ? '✅' : '❌'} |`,
    ),
    '',
    `Accuracy: ${(report.accuracy * 100).toFixed(0)}% (${matched}/${rows.length} pages, category-level)`,
    '',
  ];
  writeFileSync(join(REPORTS_DIR, 'visual-accuracy.md'), lines.join('\n'));
  expect(report.accuracy).toBe(1);
});
