// M7.5 — e2e: REAL face detection + pre-OCR blurring, end-to-end in the extension.
//
// This is the first test that exercises the face stage with an ACTUAL face: BlazeFace
// (ONNX WASM, on-device) must detect the face in the raster and black it out BEFORE
// the OCR analyzer reads it.
//   - faceStats.facesDetected >= 1  → detection happened
//   - faceStats.facesBlurred  >= 1  → the in-place black-out happened (service order:
//     faceBlur.blur(raster) runs before analyzer.analyze(raster, …))
//   - contentStatus === 'ok'        → the OCR pass still ran after the blur (pipeline
//     continuity)
//
// The image is the SAME person.jpg the model exporter used in their own notebook — a
// real face, which BlazeFace is trained to detect. A cartoon "synthetic face" would not
// be detected, and asserting otherwise would be fabrication.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import { openTestPage } from './fixtures';

test.describe.configure({ mode: 'serial' });

const FACE_B64 = readFileSync(
  join(process.cwd(), 'tests', 'e2e', 'assets', 'face-person.jpg'),
).toString('base64');

const FACE_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
  <p>Profile preview</p>
  <img class="bench-face" src="data:image/jpeg;base64,${FACE_B64}" width="480" height="360" style="display:block">
</body></html>`;

interface FaceStatsSeam {
  faceStats?: { facesDetected: number; facesBlurred: number };
  contentStatus?: string;
}

test('BlazeFace detects and blurs a real face before OCR (on-device WASM)', async ({
  extContext,
  panel,
}) => {
  await openTestPage(extContext, FACE_PAGE);

  await panel.getByRole('button', { name: 'Run Visual Check' }).dispatchEvent('click');
  await expect(panel.getByText('OCR: OCR/vision engine ran')).toBeVisible({ timeout: 30_000 });

  const stats = (await panel.evaluate(() => window.__PRIVAGENT_VISUAL__)) as FaceStatsSeam | null;
  expect(stats, 'visual stats seam must be populated').toBeTruthy();
  expect(stats?.contentStatus, 'OCR must still run after the blur').toBe('ok');
  expect(stats?.faceStats, 'faceStats must be populated by the face engine').toBeTruthy();
  expect(
    stats?.faceStats?.facesDetected,
    'a real face must be detected in the raster',
  ).toBeGreaterThanOrEqual(1);
  expect(
    stats?.faceStats?.facesBlurred,
    'the detected face must be blacked out before OCR',
  ).toBeGreaterThanOrEqual(1);
});