// REAL local OCR recognizer, backed by Tesseract.js (WebAssembly, on-device).
//
// This is the PRODUCTION engine bridged into the M3 OCR boundary (see ./index.ts).
// Everything runs locally: the worker script, the wasm core, and the English
// language data are all bundled into the extension (extension/public/ocr/**) and
// loaded from `chrome.runtime.getURL(...)` — NEVER from a CDN or any network origin
// (CONTRIBUTING.md §5, §9). No screenshot, pixel buffer, or recognized text ever leaves
// the device.
//
// LAZINESS: the ~16 MB wasm/lang assets and the worker are not touched until the
// first `recognize()` call. Registration alone (registerOcrRecognizer) loads nothing.
//
// FAIL HONEST: if the worker/wasm/lang cannot load, `recognize()` throws an Error
// tagged `OCR_ENGINE_UNAVAILABLE`. The content analyzer maps that to a `failed`
// status — we never fabricate a transcription (CONTRIBUTING.md §22).

import type { OcrImage, OcrRecognizer, OcrResult } from './index';

/** Marker so callers can distinguish a genuine load failure from a recognition error. */
export const OCR_ENGINE_UNAVAILABLE = 'OCR_ENGINE_UNAVAILABLE';

// Minimal structural view of the Tesseract.js block output we consume. Declared
// explicitly (rather than `any`) so traversal stays type-checked and lint-clean.
interface TessBBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface TessWord {
  text: string;
  confidence: number;
  bbox: TessBBox;
}
interface TessLine {
  words?: TessWord[];
}
interface TessParagraph {
  lines?: TessLine[];
}
interface TessBlock {
  paragraphs?: TessParagraph[];
}
interface TessRecognizeResult {
  data: { blocks?: TessBlock[] | null };
}
interface TessWorker {
  recognize(
    image: unknown,
    options?: unknown,
    output?: { blocks?: boolean },
  ): Promise<TessRecognizeResult>;
  terminate(): Promise<unknown>;
}

/** Resolve a bundled OCR asset to an extension-local URL. */
function assetUrl(path: string): string {
  // `chrome.runtime.getURL` is the only supported way to address packaged files from
  // an extension page. Absent (e.g. a non-extension test context) we cannot load.
  if (typeof chrome === 'undefined' || chrome.runtime?.getURL === undefined) {
    throw taggedError('chrome.runtime.getURL unavailable — not an extension context');
  }
  return chrome.runtime.getURL(path);
}

function taggedError(message: string): Error {
  const error = new Error(`${OCR_ENGINE_UNAVAILABLE}: ${message}`);
  error.name = OCR_ENGINE_UNAVAILABLE;
  return error;
}

/** Render raw RGBA pixels to a Blob the Tesseract worker can decode. */
async function imageToBlob(image: OcrImage): Promise<Blob> {
  if (typeof OffscreenCanvas === 'undefined') {
    throw taggedError('OffscreenCanvas unavailable — cannot prepare pixels for OCR');
  }
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw taggedError('2D context unavailable — cannot prepare pixels for OCR');
  // Build the ImageData via the context so the backing buffer type matches lib.dom
  // (a raw Uint8ClampedArray may be ArrayBufferLike, which the ImageData ctor rejects).
  const imageData = ctx.createImageData(image.width, image.height);
  imageData.data.set(image.data);
  ctx.putImageData(imageData, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** Flatten the block tree to word-level OCR results in raster-pixel coordinates. */
function wordsFromResult(result: TessRecognizeResult): OcrResult[] {
  const out: OcrResult[] = [];
  for (const block of result.data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const word of line.words ?? []) {
          const text = typeof word.text === 'string' ? word.text.trim() : '';
          if (text.length === 0) continue;
          const { x0, y0, x1, y1 } = word.bbox;
          out.push({
            text,
            // Tesseract confidence is 0–100; the pipeline works in 0–1.
            confidence: Math.max(0, Math.min(1, (word.confidence ?? 0) / 100)),
            bbox: [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)],
          });
        }
      }
    }
  }
  return out;
}

/**
 * Build the production Tesseract recognizer. The worker is created on the first
 * `recognize()` call and reused across regions; `dispose()` terminates it.
 */
export function createTesseractRecognizer(): OcrRecognizer {
  let workerPromise: Promise<TessWorker> | null = null;

  async function getWorker(): Promise<TessWorker> {
    if (workerPromise !== null) return workerPromise;
    workerPromise = (async (): Promise<TessWorker> => {
      let createWorker: (lang: string, oem: number, options: unknown) => Promise<TessWorker>;
      try {
        // Dynamic import keeps the heavy module out of the initial bundle/tests.
        const mod = (await import('tesseract.js')) as unknown as {
          createWorker: typeof createWorker;
        };
        createWorker = mod.createWorker;
      } catch (cause) {
        throw taggedError(`tesseract.js failed to import: ${String(cause)}`);
      }
      try {
        return await createWorker('eng', 1, {
          workerPath: assetUrl('ocr/worker.min.js'),
          corePath: assetUrl('ocr/core'),
          langPath: assetUrl('ocr/lang'),
          // MV3 CSP is `script-src 'self' 'wasm-unsafe-eval'`. Tesseract's DEFAULT
          // (`workerBlobURL: true`) spawns the worker from a `blob:` URL that
          // `importScripts()` our worker file — but a `blob:` worker is NOT an allowed
          // script source under that CSP, so the worker silently fails to start and OCR
          // yields zero regions. Spawning DIRECTLY from the extension-origin `workerPath`
          // is same-origin ('self') and therefore permitted. This is the single change
          // that makes real OCR run in the packaged extension.
          workerBlobURL: false,
          // Assets are bundled offline; do not reach for a remote cache.
          cacheMethod: 'none',
          gzip: true,
        });
      } catch (cause) {
        throw taggedError(`worker/wasm/lang failed to load: ${String(cause)}`);
      }
    })();
    // If load fails, drop the memoized rejection so a later call can retry.
    workerPromise.catch(() => {
      workerPromise = null;
    });
    return workerPromise;
  }

  return {
    name: 'tesseract.js',
    async recognize(image: OcrImage): Promise<OcrResult[]> {
      const worker = await getWorker();
      const blob = await imageToBlob(image);
      const result = await worker.recognize(blob, {}, { blocks: true });
      return wordsFromResult(result);
    },
    async dispose(): Promise<void> {
      const pending = workerPromise;
      workerPromise = null;
      if (pending === null) return;
      try {
        const worker = await pending;
        await worker.terminate();
      } catch {
        // Best-effort teardown; a failed load has nothing to terminate.
      }
    },
  };
}
