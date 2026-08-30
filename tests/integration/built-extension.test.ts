// Deterministic validation of the BUILT extension in dist/ — guards the "popup does not
// open" class of failures at their real source: the generated manifest + its referenced
// assets. Root cause we regression-guard here: the toolbar icon opens the SIDE PANEL only
// when (a) `sidePanel` permission is present (so `chrome.sidePanel.setPanelBehavior` is not
// a no-op) AND (b) no `action.default_popup` overrides that behavior. We also assert every
// asset the manifest and the panel HTML reference actually exists in dist/ (a missing/renamed
// bundle → blank panel). Requires `npm run build` first; the test fails loudly if dist/ is absent.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIST = resolve(__dirname, '../../dist');
const manifestPath = join(DIST, 'manifest.json');

/** Resolve an extension-root-absolute ("/assets/x.js") or relative asset path to a dist/ path. */
function distPath(ref: string): string {
  const clean = ref.replace(/^\//, '').split('?')[0]!.split('#')[0]!;
  return join(DIST, clean);
}

describe('built extension (dist/)', () => {
  it('has been built (run `npm run build` first)', () => {
    expect(existsSync(manifestPath)).toBe(true);
  });

  const manifest: Record<string, unknown> = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>)
    : {};
  const action = (manifest.action ?? {}) as Record<string, unknown>;
  const sidePanel = (manifest.side_panel ?? {}) as Record<string, unknown>;
  const background = (manifest.background ?? {}) as Record<string, unknown>;
  const contentScripts = (manifest.content_scripts ?? []) as Array<{ js?: string[] }>;

  it('is a valid MV3 manifest', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(typeof manifest.name).toBe('string');
    expect(typeof manifest.version).toBe('string');
  });

  it('declares the sidePanel permission so the toolbar action can open the side panel', () => {
    // Without this permission chrome.sidePanel is undefined and setPanelBehavior no-ops,
    // so clicking the icon does nothing — the exact popup-not-opening bug.
    expect(manifest.permissions).toContain('sidePanel');
  });

  it('has a valid action config that does NOT suppress openPanelOnActionClick', () => {
    // A default_popup would take precedence over the side panel behavior. It must be absent.
    expect(manifest.action).toBeTruthy();
    expect(action.default_popup).toBeUndefined();
  });

  it('declares a side_panel whose HTML asset exists in dist/', () => {
    const panel = sidePanel.default_path;
    expect(typeof panel).toBe('string');
    expect(existsSync(join(DIST, panel as string))).toBe(true);
  });

  it('has a background service worker file present in dist/', () => {
    const sw = background.service_worker;
    expect(typeof sw).toBe('string');
    expect(existsSync(join(DIST, sw as string))).toBe(true);
  });

  it('has every declared content-script file present in dist/', () => {
    const scripts = contentScripts;
    expect(scripts.length).toBeGreaterThan(0);
    for (const cs of scripts) {
      for (const js of cs.js ?? []) {
        expect(existsSync(join(DIST, js)), `content script ${js} exists`).toBe(true);
      }
    }
  });

  it('references no missing assets from the side-panel HTML entry', () => {
    const panel = sidePanel.default_path as string;
    const html = readFileSync(join(DIST, panel), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((ref) => !/^(https?:)?\/\//.test(ref)); // skip external URLs
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(existsSync(distPath(ref)), `panel asset ${ref} exists`).toBe(true);
    }
  });
});
