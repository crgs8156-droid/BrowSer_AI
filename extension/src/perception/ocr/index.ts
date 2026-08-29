// OCR boundary for PrivAgent.
//
// ⚠️ THERE IS NO BUNDLED OCR ENGINE AT M3. This module is a registration point, not
// a recognizer. With no recognizer registered, `recognize()` returns an EMPTY array.
//
// It returns nothing rather than something because a fabricated transcription is
// worse than no transcription: downstream milestones treat OCR output as observed
// page content, so invented text would become invented evidence for sensitivity
// decisions and could mask a real leak (CLAUDE.md §22).
//
// Earlier scaffolding returned a hard-coded `'Sample OCR Text'` string for any
// input. That was removed in M3 — see docs/m3-visual-perception.md for the
// rationale, the size/CSP constraints behind deferring a real engine, and exactly
// how to register one.
//
// PRIVACY: OCR output is derived from page pixels and must be treated as raw
// protected content. It stays local. It must never be logged and never placed on a
// remote payload without passing through sanitization and the privacy firewall.

export interface OcrResult {
  text: string;
  confidence: number;
  bbox: [number, number, number, number];
}

/**
 * Structural pixel input. Both `ImageData` and the pipeline's `RasterRegion`
 * satisfy this, so callers never have to convert.
 */
export interface OcrImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface OcrRecognizer {
  readonly name: string;
  recognize(image: OcrImage): Promise<OcrResult[]>;
  /** Release wasm modules, workers, and language data. */
  dispose?(): void | Promise<void>;
}

/** Lazy constructor — heavy assets must not load until first real use. */
export type OcrRecognizerFactory = () => OcrRecognizer | Promise<OcrRecognizer>;

export interface OcrEngine {
  recognize(image: OcrImage | null | undefined): Promise<OcrResult[]>;
}

let factory: OcrRecognizerFactory | null = null;
let recognizer: OcrRecognizer | null = null;

/**
 * Install a real recognizer (a locally bundled OCR engine or ONNX text model).
 * The factory is not invoked until the first `recognize()` call.
 */
export function registerOcrRecognizer(next: OcrRecognizerFactory): void {
  void disposeOcrRecognizer();
  factory = next;
}

/** True when a recognizer factory has been registered. */
export function isOcrAvailable(): boolean {
  return factory !== null;
}

export async function disposeOcrRecognizer(): Promise<void> {
  const active = recognizer;
  recognizer = null;
  if (active?.dispose !== undefined) await active.dispose();
}

/** Test hook: drop the registration and any loaded recognizer. */
export async function resetOcrRecognizer(): Promise<void> {
  await disposeOcrRecognizer();
  factory = null;
}

export function createOcrEngine(): OcrEngine {
  return {
    async recognize(image): Promise<OcrResult[]> {
      if (!image || image.width <= 0 || image.height <= 0) return [];
      if (factory === null) return [];

      if (recognizer === null) recognizer = await factory();
      return recognizer.recognize(image);
    },
  };
}
