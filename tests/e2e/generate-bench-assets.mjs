// Regenerates the deterministic bench images (tests/e2e/assets/*.png).
//
// The visual-accuracy suite renders these PNGs as <img> elements: the pixels the OCR
// engine sees are IDENTICAL on every machine (runtime fillText depends on installed
// fonts and antialiasing, which broke CI). Re-run only when a fixture value changes:
//
//   node tests/e2e/generate-bench-assets.mjs

import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'assets');
mkdirSync(outDir, { recursive: true });

const VALUES = [
  ['email', 'Contact: BENCH.EMAIL.011@example.test'],
  ['phone', 'Phone: 555-010-0011'],
  ['card', 'Card: 4111 1111 1111 1111'],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 200 } });

for (const [name, text] of VALUES) {
  // Draw + export ATOMICALLY in one evaluate: a DOM screenshot can race the canvas
  // paint (two of three assets came out blank that way). No race is possible here.
  const dataUrl = await page.evaluate((text) => {
    const canvas = document.createElement('canvas');
    canvas.width = 860;
    canvas.height = 110;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 860, 110);
    ctx.fillStyle = '#111111';
    ctx.font = '36px monospace';
    try { ctx.letterSpacing = '2px'; } catch { /* older engines */ }
    ctx.fillText(text, 24, 70);
    return canvas.toDataURL('image/png');
  }, text);
  const file = join(outDir, `bench-${name}.png`);
  writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(`wrote bench-${name}.png (${fileBytes(file)} B)`);
}

function fileBytes(path) {
  return readFileSync(path).length;
}

await browser.close();
