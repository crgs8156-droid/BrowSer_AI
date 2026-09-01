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
  VisualContentFinding,
  VisualContentStatus,
  VisualObservation,
  VisualPerceptionMetrics,
  VisualPerceptionResult,
  VisualRegion,
} from '../../types/contracts';
import { captureScreenshot } from '../screenshot';
import { VisualRegionCache, computeRasterDigest } from './cache';
import { detectVisualCapabilities, preferredBackend } from './capability';
import { decideVisualPerception } from './decision';
import { createBrowserRasterizer } from './raster';
import { MAX_ANALYSIS_EDGE, MAX_REGIONS, OCR_ANALYSIS_EDGE, selectRegions } from './regions';
import { planBelowFoldBands } from './bands';
import { disposeVisualProvider, resolveVisualProvider } from './providers/registry';
import {
  isVisualContentAnalyzerAvailable,
  resolveVisualContentAnalyzer,
} from './content-analyzer';
import { mapRasterBboxToRegion } from './coords';
import { BROWSER_RESTRICTION_REASON, isRestrictedUrl } from './restricted';
import type { RasterizeFn, VisualCapabilities } from './types';
import { ocrTrace } from '../../diag/ocr-trace';

export interface VisualPerceptionDeps {
  /** Defaults to the M2 screenshot module. Injectable for tests. */
  captureViewport?: () => Promise<string>;
  rasterize?: RasterizeFn;
  capabilities?: VisualCapabilities;
  now?: () => number;
  cache?: VisualRegionCache;
  /**
   * Scroll the inspected viewport to document y `top` (and settle). When provided,
   * the service performs BOUNDED below-the-fold band capture: it scrolls to a few
   * discrete offsets, captures the now-visible viewport at each, and restores the
   * original scroll afterwards. Absent ⇒ only the initially visible viewport is
   * inspected (below-fold images are then not covered — reported honestly, not faked).
   */
  scrollViewport?: (top: number) => Promise<void>;
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

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Reduce a caught capture error to a SHORT, non-sensitive diagnostic for the trace. The
 * value is a Chrome API failure string or a structured code (e.g. NO_ACTIVE_TAB) — never
 * pixels — but we still defensively strip anything that looks like image bytes and cap the
 * length so no capture payload can ever ride out through a log line.
 */
function safeCaptureError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown';
  if (/data:image|base64/i.test(raw)) return 'capture_error';
  return raw.slice(0, 120);
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
  const scrollViewport = deps.scrollViewport;

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

    // 4. Bounded, deterministic region set for the CURRENTLY VISIBLE viewport.
    const regions = selectRegions(snapshot, decision.candidates);

    // 4b. When a scroller is available, plan a few bounded below-the-fold bands from
    //     the whole-document candidate set, sharing the overall region budget. Absent
    //     scroller ⇒ no bands: only the visible viewport is inspected (honest limit).
    const belowFoldBands = scrollViewport
      ? planBelowFoldBands(snapshot, decision.candidates, MAX_REGIONS - regions.length)
      : [];

    const totalRegions = regions.length + belowFoldBands.reduce((n, b) => n + b.regions.length, 0);
    if (totalRegions === 0) {
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
    const contentFindings: VisualContentFinding[] = [];
    // Honest content-analysis status, escalated as regions are seen: starts unknown
    // (no regions analysed → left absent), becomes 'not_available' when the default
    // engine is used, 'ok' when a real engine ran, 'failed' if one errored.
    let contentStatus: VisualContentStatus | undefined;
    const escalate = (next: VisualContentStatus): void => {
      // failed dominates ok dominates not_available (fail closed on any error).
      const rank: Record<VisualContentStatus, number> = { not_available: 0, ok: 1, failed: 2 };
      if (contentStatus === undefined || rank[next] > rank[contentStatus]) contentStatus = next;
    };
    const originalScrollY = Math.max(0, Math.floor(snapshot.scrollY ?? 0));
    let scrolled = false;

    try {
      const backend = preferredBackend(capabilities);
      const viewportWidth = snapshot.viewport?.width ?? 0;

      // Analyse one captured viewport: `entries` pair the pixel-crop rect (band-relative)
      // with the region carrying the geometry everything downstream should see.
      const analyseCapture = async (
        captureDataUrl: string,
        entries: { crop: VisualRegion; region: VisualRegion }[],
      ): Promise<void> => {
        for (const { crop, region } of entries) {
          const raster = await rasterize(captureDataUrl, crop, {
            viewportWidth,
            // OCR needs pixel density: elevate the analysis edge ONLY when a content
            // analyzer is registered, so the default (no-engine) pipeline is unchanged.
            maxEdge: isVisualContentAnalyzerAvailable() ? OCR_ANALYSIS_EDGE : MAX_ANALYSIS_EDGE,
          });
          if (raster === null) continue;

          // Pixels were successfully decoded for this region. Dimensions only — never bytes.
          ocrTrace('PIXEL_DATA_VALID', {
            regionId: region.id,
            width: raster.width,
            height: raster.height,
          });

          // 6. Skip regions whose pixels are byte-identical to the last analysis.
          const digest = computeRasterDigest(raster);
          const cached = cache.get(region.id, digest);
          if (cached !== null) {
            fromCache++;
            observations.push(...cached.observations);
            contentFindings.push(...cached.contentFindings);
            if (cached.contentFindings.length > 0) escalate('ok');
            continue;
          }

          // 7. First heavy work in the pipeline — provider loads lazily, here.
          const provider = await resolveVisualProvider();
          const regionObservations = await provider.analyze(raster, region, backend);

          // 7b. Genuine OCR/vision content analysis over the SAME raster. With no engine
          //     registered this returns `not_available` and zero findings — never faked.
          //     Raster-pixel bboxes are mapped back into the region's coordinate space so
          //     M4/M5 mask exactly where the value was painted.
          const regionFindings: VisualContentFinding[] = [];
          try {
            const analyzer = await resolveVisualContentAnalyzer();
            ocrTrace('OCR_STARTED', { regionId: region.id, analyzer: analyzer.name });
            const analysis = await analyzer.analyze(raster, region, backend);
            escalate(analysis.status);
            // Result carries a status and a finding count only — never recognized text.
            ocrTrace('OCR_RESULT', {
              regionId: region.id,
              status: analysis.status,
              findings: analysis.findings.length,
            });
            if (analysis.status === 'ok') {
              for (const f of analysis.findings) {
                regionFindings.push({
                  regionId: region.id,
                  category: f.category,
                  confidence: clamp01(f.confidence),
                  bbox: mapRasterBboxToRegion(f.bbox, region, raster),
                  ...(typeof f.text === 'string' && f.text.length > 0 ? { text: f.text } : {}),
                  provider: analyzer.name,
                  ...(analyzer.source !== undefined ? { source: analyzer.source } : {}),
                });
              }
            }
          } catch {
            // Engine present but errored — fail closed for this region, fabricate nothing.
            escalate('failed');
          }

          cache.set(region.id, digest, regionObservations, regionFindings);
          observations.push(...regionObservations);
          contentFindings.push(...regionFindings);
          processed++;
        }
      };

      // 5. The visible viewport: one capture serves every region in it (as before).
      if (regions.length > 0) {
        let captureDataUrl: string;
        ocrTrace('CAPTURE_REQUESTED', { band: 'viewport', regions: regions.length });
        try {
          captureDataUrl = await capture();
        } catch (err) {
          // Capture was refused. This is NOT a crash and NOT necessarily a bug: the
          // browser forbids capturing some surfaces (PDF viewer, other-origin embedded
          // content, a backgrounded/none-active window) even when the top-level URL looked
          // fine. We surface a single deterministic, structured code as the RESULT reason —
          // never the raw error text — but we DO record the short, sanitized API diagnostic
          // in the trace AND on the result so the actual cause is visible to the user.
          const detail = safeCaptureError(err);
          ocrTrace('CAPTURE_FAILED', {
            band: 'viewport',
            reason: 'VISUAL_CAPTURE_UNAVAILABLE',
            detail,
          });
          return {
            status: 'unavailable',
            supported: false,
            reason: 'VISUAL_CAPTURE_UNAVAILABLE',
            reasonDetail: detail,
            observations: [],
            metrics: metrics({
              candidatesConsidered: candidateCount,
              regionsSelected: totalRegions,
              durationMs: elapsed(),
            }),
          };
        }
        ocrTrace('CAPTURE_SUCCESS', { band: 'viewport' });
        await analyseCapture(
          captureDataUrl,
          regions.map((region) => ({ crop: region, region })),
        );
      }

      // 5b. Below-the-fold bands: scroll, capture, crop. Each band failure is soft —
      //     that band's regions are simply not covered (never faked). Bounded loop.
      for (const band of belowFoldBands) {
        ocrTrace('CAPTURE_REQUESTED', { band: 'below_fold', regions: band.regions.length });
        try {
          await scrollViewport!(band.scrollY);
          scrolled = true;
          const bandCapture = await capture();
          ocrTrace('CAPTURE_SUCCESS', { band: 'below_fold' });
          await analyseCapture(
            bandCapture,
            band.regions.map(({ region, cropY }) => ({
              crop: { ...region, y: cropY },
              region,
            })),
          );
        } catch {
          // Could not capture this band — degrade closed for it and continue.
          ocrTrace('CAPTURE_FAILED', { band: 'below_fold', reason: 'band_capture_failed' });
        }
      }

      ocrTrace('OCR_REGION_COUNT', {
        contentFindings: contentFindings.length,
        contentStatus: contentStatus ?? 'none',
        regionsProcessed: processed,
        regionsFromCache: fromCache,
      });

      return {
        status: 'completed',
        supported: true,
        reason: decision.reason,
        observations,
        contentFindings,
        contentStatus,
        metrics: metrics({
          candidatesConsidered: candidateCount,
          regionsSelected: totalRegions,
          regionsProcessed: processed,
          regionsFromCache: fromCache,
          durationMs: elapsed(),
        }),
      };
    } finally {
      // Always restore the user's original scroll position if we moved it.
      if (scrolled && scrollViewport) {
        try {
          await scrollViewport(originalScrollY);
        } catch {
          // Best-effort restore; never throw from cleanup.
        }
      }
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
