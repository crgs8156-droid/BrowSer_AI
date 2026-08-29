// Execution-capability detection for M3.
//
// WebGPU is a preference, never a requirement (CLAUDE.md §10: WebGPU ↓ CPU fallback).
// The returned list is ordered by preference and always ends with 'cpu', so a
// provider can always run somewhere. Detection is feature-based — we never infer
// capabilities from user-agent strings, which keeps this working across
// Chromium (Chrome/Edge/Brave) and Firefox without per-browser branches.

import type { VisualBackend, VisualCapabilities } from './types';

/** Injectable view of the host environment so this stays unit-testable. */
export interface CapabilityEnvironment {
  hasWebGpu: boolean;
  hasWebAssembly: boolean;
  hasImageBitmap: boolean;
  hasOffscreenCanvas: boolean;
  hasDocument: boolean;
}

/** Probe the real host environment. Never throws, even in a bare Node context. */
export function readEnvironment(): CapabilityEnvironment {
  const nav: unknown = typeof navigator === 'undefined' ? undefined : navigator;
  const hasWebGpu =
    typeof nav === 'object' && nav !== null && 'gpu' in nav && (nav as { gpu?: unknown }).gpu != null;

  return {
    hasWebGpu,
    hasWebAssembly: typeof WebAssembly === 'object',
    hasImageBitmap: typeof createImageBitmap === 'function',
    hasOffscreenCanvas: typeof OffscreenCanvas === 'function',
    hasDocument: typeof document !== 'undefined',
  };
}

export function detectVisualCapabilities(
  env: CapabilityEnvironment = readEnvironment(),
): VisualCapabilities {
  const backends: VisualBackend[] = [];
  if (env.hasWebGpu) backends.push('webgpu');
  if (env.hasWebAssembly) backends.push('wasm');
  backends.push('cpu');

  return {
    backends,
    // Decoding a capture needs ImageBitmap plus somewhere to draw it. An MV3
    // service worker has neither a document nor a canvas, so rasterization is
    // only possible in a document context (side panel) or with OffscreenCanvas.
    canRasterize: env.hasImageBitmap && (env.hasOffscreenCanvas || env.hasDocument),
    hasDocument: env.hasDocument,
  };
}

/** The backend a provider should use for this run. */
export function preferredBackend(capabilities: VisualCapabilities): VisualBackend {
  return capabilities.backends[0] ?? 'cpu';
}
