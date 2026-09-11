// Provider registry for M3 — the single, documented integration point for local
// visual analysis backends.
//
// LAZINESS IS A REQUIREMENT, NOT AN OPTIMISATION. Opening a page must not load a
// provider. Nothing here instantiates anything until `resolveVisualProvider()` is
// awaited, which the service only does once a region has passed the DOM-first gate
// and been successfully rasterized.
//
// To plug in a real OCR/ONNX recognizer later (see docs/m3-visual-perception.md),
// call `registerVisualProvider()` once at startup with a factory that dynamically
// imports the heavy code. No call site in the pipeline needs to change.

import type { VisualProvider, VisualProviderFactory } from '../types';

let factory: VisualProviderFactory | null = null;
let instance: VisualProvider | null = null;
let pending: Promise<VisualProvider> | null = null;
let analysisEdge: number | null = null;

/** Declared, model-load-free requirements of a registered provider. */
export interface VisualProviderRegistration {
  /**
   * Longest raster edge this provider needs to work at all, in pixels.
   *
   * Declared at REGISTRATION time, deliberately: the service must size the raster
   * before it decides to load a model, so asking the provider instance would force
   * the very eager load this registry exists to avoid.
   */
  analysisEdge?: number;
}

/** Replace the active provider factory. Disposes any already-loaded provider. */
export function registerVisualProvider(
  next: VisualProviderFactory,
  registration: VisualProviderRegistration = {},
): void {
  void disposeVisualProvider();
  factory = next;
  analysisEdge =
    registration.analysisEdge !== undefined && registration.analysisEdge > 0
      ? Math.floor(registration.analysisEdge)
      : null;
}

/**
 * Raster edge the registered provider declared, or `null` for the default provider.
 * `null` means "no opinion" and leaves the service's own budget untouched.
 */
export function visualProviderAnalysisEdge(): number | null {
  return analysisEdge;
}

/** Default backend: dependency-free pixel statistics, imported on first real use. */
const defaultFactory: VisualProviderFactory = async () => {
  const module = await import('./pixel-stats');
  return module.createPixelStatsProvider();
};

/**
 * Instantiate (once) and return the active provider.
 * Concurrent callers share a single in-flight load.
 */
export async function resolveVisualProvider(): Promise<VisualProvider> {
  if (instance !== null) return instance;
  if (pending !== null) return pending;

  const active = factory ?? defaultFactory;
  pending = Promise.resolve(active())
    .then((provider) => {
      instance = provider;
      return provider;
    })
    .finally(() => {
      pending = null;
    });

  return pending;
}

/** Release provider-held resources (models, workers, GPU buffers). */
export async function disposeVisualProvider(): Promise<void> {
  const active = instance;
  instance = null;
  pending = null;
  if (active?.dispose !== undefined) await active.dispose();
}

/** True once a provider has actually been constructed. Used to assert laziness. */
export function isVisualProviderLoaded(): boolean {
  return instance !== null;
}

/** Test hook: forget both the registration and the loaded instance. */
export async function resetVisualProviders(): Promise<void> {
  await disposeVisualProvider();
  factory = null;
  analysisEdge = null;
}

/**
 * Phase 6A — current model-load state WITHOUT instantiating anything.
 * `not_loaded` before first resolution (startup stays instant); delegates to
 * the live provider once one exists; heuristic providers report not_loaded.
 */
export function visualProviderModelState(): 'not_loaded' | 'loading' | 'ready' | 'failed' {
  try {
    const probe = instance?.getModelState?.();
    if (probe !== undefined) return probe;
  } catch {
    // ignore - a failing probe must never break the panel
  }
  return 'not_loaded';
}
