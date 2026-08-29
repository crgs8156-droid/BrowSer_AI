// M3 — restricted-page detection and capability/backend fallback.

import { describe, expect, it } from 'vitest';
import {
  BROWSER_RESTRICTION_REASON,
  isRestrictedUrl,
} from '../../extension/src/perception/visual/restricted';
import {
  detectVisualCapabilities,
  preferredBackend,
  readEnvironment,
} from '../../extension/src/perception/visual/capability';
import type { CapabilityEnvironment } from '../../extension/src/perception/visual/capability';

function env(overrides: Partial<CapabilityEnvironment> = {}): CapabilityEnvironment {
  return {
    hasWebGpu: false,
    hasWebAssembly: true,
    hasImageBitmap: true,
    hasOffscreenCanvas: true,
    hasDocument: true,
    ...overrides,
  };
}

describe('isRestrictedUrl', () => {
  it('allows ordinary web pages', () => {
    expect(isRestrictedUrl('https://example.test/page')).toBe(false);
    expect(isRestrictedUrl('http://localhost:3000/app')).toBe(false);
  });

  it('blocks browser-internal schemes', () => {
    for (const url of [
      'chrome://settings',
      'chrome://extensions',
      'about:blank',
      'devtools://devtools/bundled/panel.html',
      'view-source:https://example.test/',
      'chrome-extension://abcdef/page.html',
      'moz-extension://abcdef/page.html',
      'edge://settings',
      'file:///C:/secret.txt',
    ]) {
      expect(isRestrictedUrl(url), url).toBe(true);
    }
  });

  it('blocks extension gallery hosts', () => {
    expect(isRestrictedUrl('https://chromewebstore.google.com/detail/x')).toBe(true);
    expect(isRestrictedUrl('https://addons.mozilla.org/en-US/firefox/')).toBe(true);
    expect(isRestrictedUrl('https://chrome.google.com/webstore/category/extensions')).toBe(true);
  });

  it('does not over-block a shared host outside the gallery path', () => {
    expect(isRestrictedUrl('https://chrome.google.com/some/other/page')).toBe(false);
  });

  it('fails closed on empty or unparseable input', () => {
    expect(isRestrictedUrl('')).toBe(true);
    expect(isRestrictedUrl('not a url')).toBe(true);
    expect(isRestrictedUrl(undefined as unknown as string)).toBe(true);
  });

  it('exposes the exact reason code required by the contract', () => {
    expect(BROWSER_RESTRICTION_REASON).toBe('browser_security_restriction');
  });
});

describe('detectVisualCapabilities', () => {
  it('prefers WebGPU when present but never requires it', () => {
    expect(detectVisualCapabilities(env({ hasWebGpu: true })).backends).toEqual([
      'webgpu',
      'wasm',
      'cpu',
    ]);
  });

  it('falls back to wasm, then cpu', () => {
    expect(detectVisualCapabilities(env()).backends).toEqual(['wasm', 'cpu']);
    expect(detectVisualCapabilities(env({ hasWebAssembly: false })).backends).toEqual(['cpu']);
  });

  it('always yields a usable backend', () => {
    const capabilities = detectVisualCapabilities(
      env({ hasWebGpu: false, hasWebAssembly: false }),
    );
    expect(preferredBackend(capabilities)).toBe('cpu');
  });

  it('reports rasterization as impossible without a canvas target', () => {
    expect(
      detectVisualCapabilities(env({ hasOffscreenCanvas: false, hasDocument: false })).canRasterize,
    ).toBe(false);
  });

  it('allows rasterization with OffscreenCanvas but no document (worker context)', () => {
    const capabilities = detectVisualCapabilities(env({ hasDocument: false }));
    expect(capabilities.canRasterize).toBe(true);
    expect(capabilities.hasDocument).toBe(false);
  });

  it('needs ImageBitmap to decode a capture', () => {
    expect(detectVisualCapabilities(env({ hasImageBitmap: false })).canRasterize).toBe(false);
  });

  it('probes the real environment without throwing', () => {
    const real = readEnvironment();
    expect(typeof real.hasDocument).toBe('boolean');
    expect(typeof real.hasWebGpu).toBe('boolean');
  });
});
