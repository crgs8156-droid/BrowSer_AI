// M3 internal implementation types for the local visual-perception pipeline.
// Cross-boundary/message types live in ../../types/contracts.ts.

import type {
  DomVisualCandidate,
  VisualObservation,
  VisualRegion,
} from '../../types/contracts';

/**
 * Decoded pixels for a single bounded region. LOCAL-ONLY.
 * Never serialize, log, store, or transmit this — release it via the pipeline's
 * cleanup path as soon as analysis completes.
 */
export interface RasterRegion {
  width: number;
  height: number;
  /** RGBA bytes, length === width * height * 4. */
  data: Uint8ClampedArray;
}

/** Execution backends, in descending order of preference. */
export type VisualBackend = 'webgpu' | 'wasm' | 'cpu';

export interface VisualCapabilities {
  /** Available backends, most preferred first. Always contains at least 'cpu'. */
  backends: VisualBackend[];
  /** Whether this context can decode a capture into pixels (canvas/ImageBitmap). */
  canRasterize: boolean;
  /** Whether a document context is present (MV3 service workers have none). */
  hasDocument: boolean;
}

export interface RasterizeOptions {
  /**
   * CSS-pixel width of the viewport the region coordinates refer to. Used to map
   * CSS pixels onto capture pixels, which differ by devicePixelRatio.
   */
  viewportWidth: number;
  /** Longest edge of the produced raster (enforces minimal analysis resolution). */
  maxEdge: number;
}

/** Crops one region out of a capture and downscales it for analysis. */
export type RasterizeFn = (
  captureDataUrl: string,
  region: VisualRegion,
  options: RasterizeOptions,
) => Promise<RasterRegion | null>;

/**
 * A local analyzer. Implementations receive pixels and return non-reversible
 * structural labels. An implementation MUST NOT perform network I/O and MUST
 * NOT return content it did not actually measure.
 */
export interface VisualProvider {
  readonly name: string;
  readonly source: 'ocr' | 'vision';
  analyze(
    raster: RasterRegion,
    region: VisualRegion,
    backend: VisualBackend,
  ): Promise<VisualObservation[]>;
  /** Release models/workers/GPU buffers. Called by the service on dispose. */
  dispose?(): void | Promise<void>;
}

/** Lazy constructor — nothing heavy may run until this is actually invoked. */
export type VisualProviderFactory = () => VisualProvider | Promise<VisualProvider>;

/** Outcome of the DOM-first sufficiency check. */
export interface VisualDecision {
  required: boolean;
  /** Non-sensitive diagnostic code. Never contains page content. */
  reason: string;
  /** The candidate subset that justifies visual work (empty when not required). */
  candidates: DomVisualCandidate[];
}
