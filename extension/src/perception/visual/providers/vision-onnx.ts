// Local vision MODEL provider — ONNX Runtime Web over a bundled YOLOv8n UI detector.
//
// This is the M3 "Vision" stage: it answers WHERE separable UI elements are inside a
// targeted region. It does not read text (that is the OCR analyzer's job, unchanged)
// and it does not classify sensitivity (that is M4's job).
//
// MODEL: OmniParser `icon_detect` (Microsoft), YOLOv8n backbone, single class
// "interactable element", 640x640 static input, exported to ONNX by onnx-community.
// The weights are AGPL-3.0 (see docs/m3-visual-perception.md §12) and are BUNDLED as
// an extension asset — nothing is ever fetched from the network at runtime, so
// inference is local by construction and no pixels can leave the device.
//
// RUNTIME: WebGPU when the capability probe found it, otherwise the wasm/CPU build of
// the SAME model. Threads are pinned to 1 and no blob-URL worker is used, because
// MV3's CSP (`script-src 'self' 'wasm-unsafe-eval'`) blocks blob: workers — the same
// constraint that shaped the Tesseract wiring.
//
// The coarse structural label still comes from the pixel-statistics provider: the
// detector has one class, so deriving `text_like_content` from it would be
// fabrication. Vision ADDS element geometry; it does not relabel the region.

import type { VisualBackend, RasterRegion, VisualProvider } from '../types';
import type { VisualElementBox, VisualObservation, VisualRegion } from '../../../types/contracts';
import { ocrTrace } from '../../../diag/ocr-trace';
import { createPixelStatsProvider } from './pixel-stats';
import {
  DEFAULT_CONFIDENCE,
  VISION_INPUT_EDGE,
  decodeDetections,
  dropDegenerate,
  letterbox,
  toElementBoxes,
} from './yolo-decode';

/** Bundled model asset, relative to the extension root. */
export const VISION_MODEL_ASSET = 'models/icon-detect-640.onnx';
/** Directory holding the ONNX Runtime wasm binaries, relative to the extension root. */
export const VISION_WASM_DIR = 'models/';
/** Name reported in observations and diagnostics. */
export const VISION_MODEL_NAME = 'omniparser-icon-detect-640';

/**
 * Minimal structural view of the parts of ORT this provider touches.
 *
 * Exported so tests can supply a runtime that returns a KNOWN detection head, which
 * is how the decode → element-geometry path is verified without a 12 MB download.
 * The real runtime satisfies this shape structurally.
 */
export interface VisionTensor {
  readonly data: unknown;
  readonly dims: readonly number[];
}
export interface VisionSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, VisionTensor>>;
  release?(): Promise<void>;
}
export interface VisionRuntime {
  env: { wasm: { wasmPaths?: string; numThreads?: number; proxy?: boolean }; logLevel?: string };
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => unknown;
  InferenceSession: {
    create(path: string | Uint8Array, options?: Record<string, unknown>): Promise<VisionSession>;
  };
}

export interface VisionOnnxOptions {
  /**
   * Where to get the graph. In the extension this is the bundled asset's
   * `chrome-extension://` URL (the default). Raw bytes are also accepted so the real
   * weights can be exercised outside a browser, where `fetch` cannot read a file path.
   */
  modelUrl?: string | Uint8Array;
  /** Absolute URL of the directory holding the ORT wasm binaries. */
  wasmDir?: string;
  /** Score floor for keeping a detection. */
  confidence?: number;
  /** Injected for tests: supplies the runtime instead of importing `onnxruntime-web`. */
  loadRuntime?: () => Promise<VisionRuntime>;
}

/** Honest, inspectable state of the model for diagnostics and tests. */
export type VisionModelState = 'not_loaded' | 'loading' | 'ready' | 'failed';

function extensionUrl(path: string): string | null {
  if (typeof chrome === 'undefined' || chrome.runtime?.getURL === undefined) return null;
  try {
    return chrome.runtime.getURL(path);
  } catch {
    return null;
  }
}

/** Execution providers to try, in order, for a given capability decision. */
export function executionProviders(backend: VisualBackend): string[] {
  // The SAME model artifact serves both paths; only the EP changes. `cpu` is ORT's
  // wasm build too, so it maps to 'wasm' rather than to a second download.
  return backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'];
}

/**
 * Build the vision provider.
 *
 * Construction is free: no import, no fetch, no wasm. The 12 MB graph loads on the
 * first `analyze` call and only for the run that needs it, which is what keeps a
 * DOM-sufficient page at zero model cost.
 */
export function createVisionOnnxProvider(options: VisionOnnxOptions = {}): VisualProvider {
  const structural = createPixelStatsProvider();
  const confidence = options.confidence ?? DEFAULT_CONFIDENCE;

  let state: VisionModelState = 'not_loaded';
  let session: VisionSession | null = null;
  let ort: VisionRuntime | null = null;
  let pending: Promise<VisionSession | null> | null = null;
  /** EP the session was actually created with — reported, never assumed. */
  let activeBackend: VisualBackend | null = null;

  const loadSession = async (backend: VisualBackend): Promise<VisionSession | null> => {
    if (session !== null) return session;
    if (state === 'failed') return null;
    if (pending !== null) return pending;

    pending = (async (): Promise<VisionSession | null> => {
      state = 'loading';
      try {
        const modelUrl = options.modelUrl ?? extensionUrl(VISION_MODEL_ASSET);
        if (modelUrl === null) throw new Error('model asset URL unavailable');

        const runtime =
          options.loadRuntime !== undefined
            ? await options.loadRuntime()
            : ((await import('onnxruntime-web')) as unknown as VisionRuntime);

        const wasmDir = options.wasmDir ?? extensionUrl(VISION_WASM_DIR);
        // Bundled binaries only. A CDN default would be a silent network dependency.
        if (wasmDir !== null) runtime.env.wasm.wasmPaths = wasmDir;
        // Single-threaded: SharedArrayBuffer needs COOP/COEP headers the panel does
        // not have, and the threaded worker is a blob: URL that MV3's CSP refuses.
        runtime.env.wasm.numThreads = 1;
        runtime.env.wasm.proxy = false;
        runtime.env.logLevel = 'error';

        const providers = executionProviders(backend);
        const created = await runtime.InferenceSession.create(modelUrl, {
          executionProviders: providers,
          graphOptimizationLevel: 'all',
        });

        ort = runtime;
        session = created;
        activeBackend = backend;
        state = 'ready';
        ocrTrace('VISION_MODEL_READY', {
          model: VISION_MODEL_NAME,
          providers: providers.join(','),
          inputs: created.inputNames.length,
          outputs: created.outputNames.length,
        });
        return created;
      } catch (err) {
        state = 'failed';
        // Structured, non-fatal: the region still gets its honest structural label,
        // and `elements` stays ABSENT so nothing pretends a detector looked.
        ocrTrace('VISION_MODEL_UNAVAILABLE', {
          model: VISION_MODEL_NAME,
          detail: err instanceof Error ? err.name : 'unknown',
        });
        return null;
      } finally {
        pending = null;
      }
    })();
    return pending;
  };

  const detect = async (
    raster: RasterRegion,
    region: VisualRegion,
    backend: VisualBackend,
  ): Promise<VisualElementBox[] | null> => {
    const active = await loadSession(backend);
    if (active === null || ort === null) return null;

    const inputName = active.inputNames[0];
    const outputName = active.outputNames[0];
    if (inputName === undefined || outputName === undefined) return null;

    const { tensor, geometry } = letterbox(raster.data, raster.width, raster.height);
    const output = await active.run({
      [inputName]: new ort.Tensor('float32', tensor, [1, 3, VISION_INPUT_EDGE, VISION_INPUT_EDGE]),
    });
    const head = output[outputName];
    if (head === undefined || !(head.data instanceof Float32Array)) return null;

    const decoded = decodeDetections(head.data, head.dims, geometry, confidence);
    const real = dropDegenerate(decoded, raster.width, raster.height);
    return toElementBoxes(real, region, raster.width, raster.height);
  };

  return {
    name: VISION_MODEL_NAME,
    source: 'vision',
    getModelState: () => state,

    async analyze(
      raster: RasterRegion,
      region: VisualRegion,
      backend: VisualBackend,
    ): Promise<VisualObservation[]> {
      // Structural label first: it is cheap, dependency-free, and stays correct even
      // if the model is unavailable. Vision then ADDS geometry to it.
      const base = await structural.analyze(raster, region, backend);
      // The heuristics refused to describe these pixels (malformed/degenerate raster).
      // Running a detector over them and reporting boxes would be asserting more than
      // the weaker analysis was willing to assert, so report nothing.
      if (base.length === 0) return base;

      // 640-edge guard: the icon-detect-640 graph has a static 640x640 input and goes
      // silent on smaller rasters (measured: 33 elements at 640, 0 at 192). Fall back
      // to the heuristic result with a warning — never return empty silently.
      // NOTE: `source` stays 'vision' (the `VisualProvider` type admits only
      // 'ocr' | 'vision'); the heuristic origin is recorded in the trace instead.
      if (raster.width < VISION_INPUT_EDGE || raster.height < VISION_INPUT_EDGE) {
        ocrTrace('VISION_IMAGE_TOO_SMALL', {
          regionId: region.id,
          width: raster.width,
          height: raster.height,
          need: VISION_INPUT_EDGE,
          fallback: 'heuristic',
        });
        return base;
      }

      let elements: VisualElementBox[] | null = null;
      try {
        elements = await detect(raster, region, backend);
      } catch (err) {
        ocrTrace('VISION_INFERENCE_FAILED', {
          regionId: region.id,
          detail: err instanceof Error ? err.name : 'unknown',
        });
        elements = null;
      }
      // Model never ran ⇒ report exactly what the heuristics found, nothing more.
      if (elements === null) return base;

      ocrTrace('VISION_ELEMENTS', { regionId: region.id, elements: elements.length });

      const observation = base[0];
      const labels = observation?.observations ?? [];
      return [
        {
          type: 'visual_observation',
          source: 'vision',
          region,
          observations: elements.length > 0 ? [...labels, 'ui_elements'] : [...labels],
          confidence: observation?.confidence ?? 0,
          local: true,
          elements,
          model: VISION_MODEL_NAME,
          ...(activeBackend !== null ? { backend: activeBackend } : {}),
        },
      ];
    },

    async dispose(): Promise<void> {
      const active = session;
      session = null;
      ort = null;
      activeBackend = null;
      state = 'not_loaded';
      if (active?.release !== undefined) {
        try {
          await active.release();
        } catch {
          // Releasing a dead session must never surface as a pipeline error.
        }
      }
      await structural.dispose?.();
    },
  };
}

