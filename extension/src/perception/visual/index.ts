// M3 — Lightweight local visual perception. Public entry point.
//
// Typical use (from a document context such as the side panel):
//
//   const service = createVisualPerceptionService();
//   const result = await service.run(snapshot);   // snapshot from the background SW
//   // result.status: 'not_required' | 'completed' | 'unavailable' | 'restricted_page'
//   await service.dispose();
//
// M3 answers "where does information appear to live, and what kind is it?".
// It does NOT decide sensitivity and does NOT transcribe text — see
// docs/m3-visual-perception.md for the OCR/model integration point.

export { createVisualPerceptionService } from './service';
export type { VisualPerceptionDeps, VisualPerceptionService } from './service';

export { collectVisualCandidatesInPage } from './collect-candidates';
export { decideVisualPerception } from './decision';
export { isRestrictedUrl, BROWSER_RESTRICTION_REASON } from './restricted';
export { detectVisualCapabilities, preferredBackend, readEnvironment } from './capability';
export { MAX_ANALYSIS_EDGE, MAX_REGIONS, analysisScale, selectRegions } from './regions';
export { VisualRegionCache, computeRasterDigest } from './cache';
export { createBrowserRasterizer } from './raster';

export {
  disposeVisualProvider,
  isVisualProviderLoaded,
  registerVisualProvider,
  resetVisualProviders,
  resolveVisualProvider,
} from './providers/registry';

export type {
  RasterRegion,
  RasterizeFn,
  RasterizeOptions,
  VisualBackend,
  VisualCapabilities,
  VisualDecision,
  VisualProvider,
  VisualProviderFactory,
} from './types';
