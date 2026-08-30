// M3 internal implementation types for the local visual-perception pipeline.
// Cross-boundary/message types live in ../../types/contracts.ts.

import type {
  DomVisualCandidate,
  PerceptionSource,
  SensitiveCategory,
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

// ---------------------------------------------------------------------------
// OCR / vision CONTENT analysis — a provider-agnostic engine that recognizes WHAT
// sensitive value a region contains (category + geometry + optional text), distinct
// from the coarse structural `VisualProvider` above. There is NO engine bundled at
// M3/M5: the default analyzer returns `not_available` rather than pretending
// (CLAUDE.md §22). The interface is ready for a real local engine (ONNX/OCR) to be
// registered via `content-analyzer.ts` with no call-site change.
// ---------------------------------------------------------------------------

/** One recognized finding, in RASTER pixel coordinates — the space an OCR/vision
 *  engine natively produces. The service maps `bbox` back to document CSS px. */
export interface RawVisualContentFinding {
  category: SensitiveCategory;
  confidence: number;
  /** [x, y, width, height] in raster pixels (of the analyzed crop). */
  bbox: [number, number, number, number];
  /** Recognized raw text, when available. LOCAL-ONLY. */
  text?: string;
}

/** Result of analyzing ONE region. `status` is explicit and honest: an engine that
 *  cannot run returns `not_available`; one that errors returns `failed`. Findings
 *  are only meaningful when `status === 'ok'`. */
export interface VisualContentAnalyzerResult {
  status: 'ok' | 'not_available' | 'failed';
  findings: RawVisualContentFinding[];
}

/**
 * A provider-agnostic OCR/vision content analyzer. Given decoded pixels for one
 * bounded region it returns categorized findings OR an explicit non-`ok` status.
 * An implementation MUST NOT perform network I/O and MUST NOT fabricate a finding
 * it did not actually recognize.
 */
export interface VisualContentAnalyzer {
  readonly name: string;
  /** Perception source of this analyzer's findings (OCR vs coarse VISION).
   *  Absent ⇒ downstream treats findings as VISION. */
  readonly source?: PerceptionSource;
  analyze(
    raster: RasterRegion,
    region: VisualRegion,
    backend: VisualBackend,
  ): Promise<VisualContentAnalyzerResult>;
  /** Release models/workers/GPU buffers. Called by the registry on dispose. */
  dispose?(): void | Promise<void>;
}

/** Lazy constructor — heavy engine assets must not load until first real use. */
export type VisualContentAnalyzerFactory = () =>
  | VisualContentAnalyzer
  | Promise<VisualContentAnalyzer>;

/** Outcome of the DOM-first sufficiency check. */
export interface VisualDecision {
  required: boolean;
  /** Non-sensitive diagnostic code. Never contains page content. */
  reason: string;
  /** The candidate subset that justifies visual work (empty when not required). */
  candidates: DomVisualCandidate[];
}
