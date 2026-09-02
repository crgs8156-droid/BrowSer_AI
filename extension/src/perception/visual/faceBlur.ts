// M7.5 — on-device face detection + blurring (BlazeFace via ONNX Runtime Web).
//
// PRIVACY & ARCHITECTURE:
//   - Everything runs ON-DEVICE: the ONNX model and the ORT WASM runtime are packaged
//     into the extension; there is no remote call of any kind.
//   - WASM execution provider ONLY (no WebGPU): WebGPU is unstable in MV3 offscreen/
//     extension page contexts and fails silently — see the milestone brief.
//   - The raster is blurred IN PLACE before the OCR analyzer sees it, so painted faces
//     are never handed to any downstream consumer.
//   - Failure is NEVER fatal: a missing/broken model or runtime degrades to zero faces
//     and the perception pipeline continues (fail-open for availability, never for
//     privacy — nothing sensitive is produced by skipping a blur). Availability is
//     remembered so a broken environment is not retried on every scan.
//   - Diagnostics go through `ocrTrace` (counts/codes only, never pixels), keeping the
//     perception modules free of console/network/storage (leakage-test invariant).
//
// WHY THE SIDE PANEL, NOT THE OFFSCREEN DOCUMENT: the M3 split-by-context decision put
// rasterization + analysis in the panel document (the service worker cannot run
// canvas/OffscreenCanvas). The face-blur step consumes THAT raster where it already
// lives; routing it through the (unregistered) offscreen document would add a
// cross-document pixel message path without any capability gain. The offscreen doc
// remains reserved for future workloads the panel genuinely cannot host.
//
// MODEL: `blazeface.onnx` (MediaPipe BlazeFace front, end-to-end ONNX export —
// anchor decoding, the 0.7 confidence threshold and NMS are baked into the graph).
// Preprocessing evidence comes from the exporter's own notebook: RGB, resized to
// 128×128, normalized x/127.5 - 1.0 → [-1, 1] (NOT [0, 1] — the conversion derives
// from the MediaPipe TFLite model, which expects [-1, 1] range inputs).
// The graph takes the confidence threshold as an INPUT and outputs post-NMS
// detections: [N, 16] normalized (topLeftY, topLeftX, bottomRightY, bottomRightX,
// 12 landmark coords) in [0, 1].
// Model presence is OPTIONAL: the build copies it into dist/ when it exists
// (`scripts/fetch-blazeface.sh`), and a missing file degrades to the honest
// zero-faces path below.

import { ocrTrace } from '../../diag/ocr-trace';

/** Model input edge (MediaPipe BlazeFace front range). */
const MODEL_INPUT_EDGE = 128;
/** Detections below this graph-level confidence are suppressed inside the model. */
const CONFIDENCE_THRESHOLD = 0.7;
/** NonMaxSuppression cap fed to the graph (faces on a page: tiny). */
const MAX_DETECTIONS = 20;
/** IoU threshold fed to the graph (post-processing is baked into the model). */
const IOU_THRESHOLD = 0.3;
/** ORT WASM runtime files are copied here by the build (`vite.config.ts`). */
const ORT_WASM_DIR = 'ort/';
/** Packaged model path inside the extension (copied by the build when present). */
const MODEL_PATH = 'models/blazeface.onnx';

export interface FaceBlurResult {
  facesDetected: number;
  facesBlurred: number;
}

/** Minimal raster shape (structurally identical to `RasterRegion`). */
export interface BlurRaster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Minimal session shape — real ORT sessions are wrapped into it; tests fake it. */
export interface FaceSessionLike {
  inputNames: readonly string[];
  run(feeds: Record<string, OrtValueLike>): Promise<Record<string, OrtValueLike>>;
}

export interface OrtValueLike {
  data: Float32Array | BigInt64Array | Int32Array;
  dims: readonly number[];
}

export interface FaceRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FaceBlurEngine {
  /** Detect faces in the raster and black them out in place. Never throws. */
  blur(raster: BlurRaster): Promise<FaceBlurResult>;
}

export interface FaceBlurEngineOptions {
  /** Session factory — injectable so tests never touch ONNX or the network. */
  createSession?: () => Promise<FaceSessionLike>;
  /** Graph-level detection confidence (milestone brief: 0.7). */
  threshold?: number;
}

/** RGBA raster → NCHW [1, 3, 128, 128] Float32, RGB channels in [-1, 1]. */
export function preprocessRaster(raster: BlurRaster): Float32Array {
  const output = new Float32Array(3 * MODEL_INPUT_EDGE * MODEL_INPUT_EDGE);
  const scaleX = raster.width / MODEL_INPUT_EDGE;
  const scaleY = raster.height / MODEL_INPUT_EDGE;
  for (let y = 0; y < MODEL_INPUT_EDGE; y++) {
    // Nearest-neighbour source sampling: deterministic, allocation-free, and exactly
    // reproducible in tests (bilinear interpolation adds nothing for detection).
    const sourceY = Math.min(raster.height - 1, Math.floor(y * scaleY));
    for (let x = 0; x < MODEL_INPUT_EDGE; x++) {
      const sourceX = Math.min(raster.width - 1, Math.floor(x * scaleX));
      const sourceIndex = (sourceY * raster.width + sourceX) * 4;
      const channelStart = y * MODEL_INPUT_EDGE + x;
      const red = raster.data[sourceIndex] ?? 0;
      const green = raster.data[sourceIndex + 1] ?? 0;
      const blue = raster.data[sourceIndex + 2] ?? 0;
      output[channelStart] = red / 127.5 - 1.0; // R
      output[MODEL_INPUT_EDGE * MODEL_INPUT_EDGE + channelStart] = green / 127.5 - 1.0; // G
      output[2 * MODEL_INPUT_EDGE * MODEL_INPUT_EDGE + channelStart] = blue / 127.5 - 1.0; // B
    }
  }
  return output;
}

/**
 * Parse the end-to-end graph output: [N, 16] normalized rows
 * (topLeftY, topLeftX, bottomRightY, bottomRightX, landmarks…). Rows already passed
 * the graph-level 0.7 threshold + NMS. Returns raster-space rects, clamped, with
 * degenerate or out-of-range boxes dropped.
 */
export function parseDetections(
  output: OrtValueLike,
  rasterWidth: number,
  rasterHeight: number,
): FaceRegion[] {
  const dims = output.dims;
  const rows = dims.length >= 2 ? (dims[dims.length - 2] ?? 0) : 0;
  const columns = dims.length >= 2 ? (dims[dims.length - 1] ?? 0) : 0;
  if (columns < 4) return [];

  const regions: FaceRegion[] = [];
  for (let row = 0; row < rows; row++) {
    const base = row * columns;
    const y1 = Number(output.data[base]);
    const x1 = Number(output.data[base + 1]);
    const y2 = Number(output.data[base + 2]);
    const x2 = Number(output.data[base + 3]);
    if (![y1, x1, y2, x2].every((value) => Number.isFinite(value))) continue;
    if ([y1, x1, y2, x2].some((value) => value < 0 || value > 1)) continue;

    const left = Math.min(x1, x2) * rasterWidth;
    const right = Math.max(x1, x2) * rasterWidth;
    const top = Math.min(y1, y2) * rasterHeight;
    const bottom = Math.max(y1, y2) * rasterHeight;
    const width = right - left;
    const height = bottom - top;
    if (width < 1 || height < 1) continue;

    regions.push({
      x: Math.max(0, Math.floor(left)),
      y: Math.max(0, Math.floor(top)),
      width: Math.min(rasterWidth, Math.ceil(width)),
      height: Math.min(rasterHeight, Math.ceil(height)),
    });
  }
  return regions;
}

/** Black out `regions` in the raster, in place, clamped to raster bounds. */
export function blurRegions(raster: BlurRaster, regions: FaceRegion[]): number {
  let blurred = 0;
  for (const region of regions) {
    const xStart = Math.max(0, Math.floor(region.x));
    const yStart = Math.max(0, Math.floor(region.y));
    const xEnd = Math.min(raster.width, Math.ceil(region.x + region.width));
    const yEnd = Math.min(raster.height, Math.ceil(region.y + region.height));
    if (xEnd <= xStart || yEnd <= yStart) continue;
    for (let y = yStart; y < yEnd; y++) {
      for (let x = xStart; x < xEnd; x++) {
        const index = (y * raster.width + x) * 4;
        raster.data[index] = 0;
        raster.data[index + 1] = 0;
        raster.data[index + 2] = 0;
        raster.data[index + 3] = 255;
      }
    }
    blurred++;
  }
  return blurred;
}

function pickInputName(inputNames: readonly string[], keyword: string): string | undefined {
  return inputNames.find((name) => name.toLowerCase().includes(keyword));
}

/**
 * Default session factory (extension runtime): lazy ONNX WASM session over the
 * packaged model + runtime files. The real ORT session is wrapped into the minimal
 * `FaceSessionLike` shape so the engine logic stays runtime-agnostic and testable.
 * Never called in tests (they inject their own factory).
 */
async function createOrtSession(): Promise<FaceSessionLike> {
  const ort = await import('onnxruntime-web');
  // WASM backend only (milestone brief: WebGPU is unstable in MV3 contexts). The
  // threaded WASM needs cross-origin isolation for multi-threading, which extension
  // pages do not have — pin to a single thread explicitly.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = chrome.runtime.getURL(ORT_WASM_DIR);
  const session = await ort.InferenceSession.create(chrome.runtime.getURL(MODEL_PATH), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });

  return {
    inputNames: session.inputNames,
    run: async (feeds) => {
      const tensors: Record<string, import('onnxruntime-web').Tensor> = {};
      for (const [name, value] of Object.entries(feeds)) {
        tensors[name] =
          value.data instanceof BigInt64Array
            ? new ort.Tensor('int64', value.data, value.dims)
            : new ort.Tensor('float32', value.data as Float32Array, value.dims);
      }
      const output = await session.run(tensors);
      const wrapped: Record<string, OrtValueLike> = {};
      for (const [name, tensor] of Object.entries(output)) {
        wrapped[name] = { data: tensor.data as Float32Array, dims: tensor.dims };
      }
      return wrapped;
    },
  };
}

export function createFaceBlurEngine(options: FaceBlurEngineOptions = {}): FaceBlurEngine {
  const threshold = options.threshold ?? CONFIDENCE_THRESHOLD;
  let sessionPromise: Promise<FaceSessionLike> | null = null;
  let unavailable = false;

  const getSession = async (): Promise<FaceSessionLike> => {
    if (unavailable) throw new Error('FACE_BLUR_UNAVAILABLE');
    sessionPromise ??= (options.createSession ?? createOrtSession)();
    try {
      return await sessionPromise;
    } catch (error) {
      // Model/runtime unavailable: never retry-spam a broken environment, and never
      // block the pipeline. Counts stay zero (documented honest gap).
      unavailable = true;
      sessionPromise = null;
      ocrTrace('FACE_BLUR_UNAVAILABLE', {
        reason: error instanceof Error ? error.name : 'UNKNOWN',
      });
      throw new Error('FACE_BLUR_UNAVAILABLE');
    }
  };

  return {
    async blur(raster: BlurRaster): Promise<FaceBlurResult> {
      try {
        const session = await getSession();

        const feeds: Record<string, OrtValueLike> = {};
        const imageInput = pickInputName(session.inputNames, 'input');
        if (imageInput === undefined) throw new Error('FACE_BLUR_INPUT_MISSING');
        feeds[imageInput] = {
          data: preprocessRaster(raster),
          dims: [1, 3, MODEL_INPUT_EDGE, MODEL_INPUT_EDGE],
        };
        const confidenceInput = pickInputName(session.inputNames, 'conf');
        if (confidenceInput !== undefined) {
          feeds[confidenceInput] = { data: new Float32Array([threshold]), dims: [1] };
        }
        const iouInput = pickInputName(session.inputNames, 'iou');
        if (iouInput !== undefined) {
          feeds[iouInput] = { data: new Float32Array([IOU_THRESHOLD]), dims: [1] };
        }
        const maxDetectionsInput = pickInputName(session.inputNames, 'max');
        if (maxDetectionsInput !== undefined) {
          feeds[maxDetectionsInput] = {
            data: new BigInt64Array([BigInt(MAX_DETECTIONS)]),
            dims: [1],
          };
        }

        const outputs = await session.run(feeds);
        const outputName = Object.keys(outputs)[0];
        const output = outputName === undefined ? undefined : outputs[outputName];
        if (!output) return { facesDetected: 0, facesBlurred: 0 };

        const regions = parseDetections(output, raster.width, raster.height);
        const facesBlurred = blurRegions(raster, regions);
        ocrTrace('FACE_BLUR_DONE', { facesDetected: regions.length, facesBlurred });
        return { facesDetected: regions.length, facesBlurred };
      } catch {
        // Missing model / runtime / session failure → degrade honestly, continue.
        return { facesDetected: 0, facesBlurred: 0 };
      }
    },
  };
}
