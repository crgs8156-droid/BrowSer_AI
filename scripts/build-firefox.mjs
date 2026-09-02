// Firefox MV3 build transform (time-boxed spike): post-processes a Chrome build
// (`npm run build`) into `dist-firefox/`.
//
// What Firefox MV3 needs that Chrome does not:
//   1. background: event page (`scripts: [...]`), NOT `service_worker` — and Firefox
//      does not support ES modules in background scripts, so the CRXJS loader's import
//      target is inlined directly (the built background chunk is self-contained;
//      verified by this script — it refuses to emit a Firefox build with module imports).
//   2. `sidebar_action` instead of the `sidePanel` permission/API.
//   3. `browser_specific_settings.gecko.id` (required to install).
//
// KNOWN GAPS (honest, see PROJECT_STATUS): not yet executed in a real Firefox; the
// toolbar-click panel-open path is Chrome-only (`chrome.sidePanel`), so on Firefox the
// user opens the sidebar manually; Playwright cannot load extensions in Firefox, so
// verification is manual (`web-ext run`).

import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const out = join(root, 'dist-firefox');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(dist, out, { recursive: true });

const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));

const loader = readFileSync(join(out, manifest.background.service_worker), 'utf8');
const imports = [...loader.matchAll(/import\s+['\"]([^'\"]+)['"];?/g)].map((m) => m[1]);
if (imports.length !== 1) {
  throw new Error(
    `Firefox transform: expected exactly one import in the service-worker loader, found ${imports.length}. ` +
      'The background chunk is no longer self-contained — revisit this script.',
  );
}
const backgroundScript = imports[0].replace(/^\.\//, '');
if (/import\s|export\s/.test(readFileSync(join(out, backgroundScript), 'utf8'))) {
  throw new Error('Firefox transform: background chunk still contains module syntax.');
}

manifest.background = { scripts: [backgroundScript] };
manifest.permissions = (manifest.permissions ?? []).filter((p) => p !== 'sidePanel');
manifest.sidebar_action = {
  default_panel: manifest.side_panel.default_path,
  default_title: manifest.name,
};
delete manifest.side_panel;
manifest.browser_specific_settings = {
  gecko: { id: 'privagent@sih2026.test', strict_min_version: '128.0' },
};

writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`dist-firefox/ ready (background: ${backgroundScript}).`);
console.log('Manual verification (not automatable: Playwright cannot load extensions in Firefox):');
console.log('  web-ext run --source-dir dist-firefox');
