// M3 visual-perception service: the one orchestrator for local visual observation.
//
// Ordering matters and is enforced here:
//   1. restricted-page check   (never fight browser security)
//   2. DOM-first sufficiency   (usually exits here — no capture, no provider load)
//   3. capability check        (rasterization possible in this context?)
//   4. bounded region select   (≤ MAX_REGIONS, clamped to viewport)
//   5. capture + crop          (raw pixels, local only)
//   6. cache lookup by digest  (unchanged regions are not reprocessed)
//   7. lazy provider analysis  (first heavy work of the entire pipeline)
//
// PRIVACY INVARIANTS UPHELD HERE:
//   - the capture data URL and every raster stay in local variables and are dropped
//     as soon as a region is analysed;
//   - nothing in this file logs page content, pixels, or capture bytes;
//   - only derived VisualObservation labels leave the service.
//
// FAILURE POSTURE: every unexpected condition degrades to a structured
// `unavailable`/`not_required` result. The service never throws at its callers and
// never guesses an observation it did not measure.

import type {
  DomVisualSnapshot,
  VisualObservation,
  VisualPerceptionMetrics,
  VisualPerceptionResult,
} from '../../types/contracts';
import { captureScreenshot } from '../screenshot';
import { VisualRegionCache, computeRasterDigest } from './cache';
import { detectVisualCapabilities, preferredBackend } from './capability';
import { decideVisualPerception } from './decision';
import { createBrowserRasterizer } from './raster';
import { MAX_ANALYSIS_EDGE, selectRegions } from './regions';
import { disposeVisualProvider, resolveVisualProvider } from './providers/registry';
import { BROWSER_RESTRICTION_REASON, isRestrictedUrl } from './restricted';
import type { RasterizeFn, VisualCapabilities } from './types';

export interface VisualPerceptionDeps {
  /** Defaults to the M2 screenshot module. Injectable for tests. */
  captureViewport?: () => Promise<string>;
  rasterize?: RasterizeFn;
  capabilities?: VisualCapabilities;
  now?: () => number;
  cache?: VisualRegionCache;
}

export interface VisualPerceptionService {
  run(snapshot: DomVisualSnapshot): Promise<VisualPerceptionResult>;
  dispose(): Promise<void>;
}

function metrics(partial: Partial<VisualPerceptionMetrics>): VisualPerceptionMetrics {
  return {
    candidatesConsidered: partial.candidatesConsidered ?? 0,
    regionsSelected: partial.regionsSelected ?? 0,
    regionsProcessed: partial.regionsProcessed ?? 0,
    regionsFromCache: partial.regionsFromCache ?? 0,
    durationMs: partial.durationMs ?? 0,
  };
}

function defaultNow(): number {
  return typeof performance === 'object' ? performance.now() : 0;
}

export function createVisualPerceptionService(
  deps: VisualPerceptionDeps = {},
): VisualPerceptionService {
  const capture = deps.captureViewport ?? (() => captureScreenshot());
  const now = deps.now ?? defaultNow;
  const cache = deps.cache ?? new VisualRegionCache();
  // Capabilities are probed once per service, not once per page.
  const capabilities = deps.capabilities ?? detectVisualCapabilities();
  // The rasterizer closes over the host context; built eagerly but does no work.
  const rasterize = deps.rasterize ?? createBrowserRasterizer();

  let inFlight = false;

  async function run(snapshot: DomVisualSnapshot): Promise<VisualPerceptionResult> {
    const startedAt = now();
    const elapsed = (): number => Math.round((now() - startedAt) * 100) / 100;

    if (snapshot === null || typeof snapshot !== 'object') {
      return {
        status: 'unavailable',
        supported: false,
        reason: 'invalid_snapshot',
        observations: [],
        metrics: metrics({ durationMs: elapsed() }),
      };
    }

    // 1. Browser security. Checked before anything else and never bypassed.
    if (isRestrictedUrl(snapshot.url)) {
      return {
        status: 'restricted_page',
        supported: false,
        reason: BROWSER_RESTRICTION_REASON,
        observations: [],
        metrics: metrics({ durationMs: elapsed() }),
      };
    }

    // Reject overlapping runs so repeated triggers cannot stack CPU work.
    if (inFlight) {
      return {
        status: 'running',
        supported: true,
        reason: 'run_in_progress',
        observations: [],
        metrics: metrics({ durationMs: elapsed() }),
      };
    }

    const candidateCount = Array.isArray(snapshot.candidates) ? snapshot.candidates.length : 0;

    // 2. DOM-first gate. The common case returns here: no capture, no provider.
    const decision = decideVisualPerception(snapshot);
    if (!decision.required) {
      return {
        status: 'not_required',
        supported: true,
        reason: decision.reason,
        observations: [],
        metrics: metrics({ candidatesConsidered: candidateCount, durationMs: elapsed() }),
      };
    }

    // 3. Can this context turn a capture into pixels at all?
    if (!capabilities.canRasterize) {
      return {
        status: 'unavailable',
        supported: false,
        reason: 'rasterization_unsupported_in_context',
        observations: [],
        metrics: metrics({ candidatesConsidered: candidateCount, durationMs: elapsed() }),
      };
    }

    // 4. Bounded, deterministic region set.
    const regions = selectRegions(snapshot, decision.candidates);
    if (regions.length === 0) {
      return {
        status: 'not_required',
        supported: true,
        reason: 'no_regions_after_bounding',
        observations: [],
        metrics: metrics({ candidatesConsidered: candidateCount, durationMs: elapsed() }),
      };
    }

    inFlight = true;
    let processed = 0;
    let fromCache = 0;
    const observations: VisualObservation[] = [];

    try {
      // 5. One capture serves every region in this run.
      let captureDataUrl: string;
      try {
        captureDataUrl = await capture();
      } catch {
        // Capture is refused on protected surfaces even when the URL looked fine.
        // Error text is not logged — it can embed the capture payload.
        return {
          status: 'unavailable',
          supported: false,
          reason: 'capture_failed',
          observations: [],
          metrics: metrics({
            candidatesConsidered: candidateCount,
            regionsSelected: regions.length,
            durationMs: elapsed(),
          }),
        };
      }

      const backend = preferredBackend(capabilities);
      const viewportWidth = snapshot.viewport?.width ?? 0;

      for (const region of regions) {
        const raster = await rasterize(captureDataUrl, region, {
          viewportWidth,
          maxEdge: MAX_ANALYSIS_EDGE,
        });
        if (raster === null) continue;

        // 6. Skip regions whose pixels are byte-identical to the last analysis.
        const digest = computeRasterDigest(raster);
        const cached = cache.get(region.id, digest);
        if (cached !== null) {
          fromCache++;
          observations.push(...cached);
          continue;
        }

        // 7. First heavy work in the pipeline — provider loads lazily, here.
        const provider = await resolveVisualProvider();
        const regionObservations = await provider.analyze(raster, region, backend);
        cache.set(region.id, digest, regionObservations);
        observations.push(...regionObservations);
        processed++;
      }

      return {
        status: 'completed',
        supported: true,
        reason: decision.reason,
        observations,
        metrics: metrics({
          candidatesConsidered: candidateCount,
          regionsSelected: regions.length,
          regionsProcessed: processed,
          regionsFromCache: fromCache,
          durationMs: elapsed(),
        }),
      };
    } finally {
      inFlight = false;
    }
  }

  return {
    run,
    async dispose(): Promise<void> {
      cache.clear();
      await disposeVisualProvider();
    },
  };
}
