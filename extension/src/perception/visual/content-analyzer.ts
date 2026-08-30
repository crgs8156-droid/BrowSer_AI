// Content-analyzer registry for the OCR/vision layer — the single, documented
// integration point for a REAL local engine that recognizes WHAT sensitive value a
// captured region contains.
//
// HONESTY IS THE DEFAULT. No OCR/vision engine is bundled at M3/M5. Until one is
// registered, `resolveVisualContentAnalyzer()` returns an analyzer that ALWAYS reports
// `not_available` and returns zero findings — it never invents a detection (CLAUDE.md
// §22). This mirrors `providers/registry.ts`; to plug in a real engine later, call
// `registerVisualContentAnalyzer()` once at startup with a factory that dynamically
// imports the heavy code. No call site in the pipeline needs to change.
//
// LAZINESS: nothing heavy is instantiated until `resolveVisualContentAnalyzer()` is
// awaited, which the service only does after a region has been rasterized.

import type {
  VisualContentAnalyzer,
  VisualContentAnalyzerFactory,
} from './types';

/** The honest default: present, but reports it cannot analyze. Never fabricates. */
const UNAVAILABLE_ANALYZER: VisualContentAnalyzer = {
  name: 'none',
  analyze: () => Promise.resolve({ status: 'not_available', findings: [] }),
};

let factory: VisualContentAnalyzerFactory | null = null;
let instance: VisualContentAnalyzer | null = null;
let pending: Promise<VisualContentAnalyzer> | null = null;

/** Replace the active analyzer factory. Disposes any already-loaded analyzer. */
export function registerVisualContentAnalyzer(next: VisualContentAnalyzerFactory): void {
  void disposeVisualContentAnalyzer();
  factory = next;
}

/**
 * Instantiate (once) and return the active analyzer. With no factory registered,
 * the always-`not_available` analyzer is returned WITHOUT constructing anything.
 * Concurrent callers share a single in-flight load.
 */
export async function resolveVisualContentAnalyzer(): Promise<VisualContentAnalyzer> {
  if (factory === null) return UNAVAILABLE_ANALYZER;
  if (instance !== null) return instance;
  if (pending !== null) return pending;

  pending = Promise.resolve(factory())
    .then((analyzer) => {
      instance = analyzer;
      return analyzer;
    })
    .finally(() => {
      pending = null;
    });

  return pending;
}

/** Release analyzer-held resources (models, workers, GPU buffers). */
export async function disposeVisualContentAnalyzer(): Promise<void> {
  const active = instance;
  instance = null;
  pending = null;
  if (active?.dispose !== undefined) await active.dispose();
}

/** True once a real analyzer has actually been constructed. Asserts laziness. */
export function isVisualContentAnalyzerLoaded(): boolean {
  return instance !== null;
}

/** True when a real analyzer factory has been registered (engine is available). */
export function isVisualContentAnalyzerAvailable(): boolean {
  return factory !== null;
}

/** Test hook: forget both the registration and any loaded instance. */
export async function resetVisualContentAnalyzer(): Promise<void> {
  await disposeVisualContentAnalyzer();
  factory = null;
}
