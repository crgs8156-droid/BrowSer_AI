// Production OCR wiring — the ONE place the real local engine is installed.
//
// Called once at side-panel startup. It registers:
//   1. the real Tesseract.js recognizer into the M3 OCR boundary (../ocr), and
//   2. the OCR content analyzer into the visual-perception pipeline
//      (./visual/content-analyzer),
// so a captured region is transcribed on-device and classified with the same M2
// detector used for the DOM. Both registrations are LAZY: no wasm/worker/lang asset
// loads until the pipeline actually analyzes a region.
//
// Tests never import this module — they register a FAKE recognizer instead, so unit
// and integration runs stay fast, deterministic, and network-free while production
// uses the real engine (CLAUDE.md §12, requirement I).

import { registerOcrRecognizer } from './ocr';
import { createTesseractRecognizer } from './ocr/tesseract';
import { registerVisualContentAnalyzer } from './visual/content-analyzer';
import { createOcrContentAnalyzer } from './visual/ocr-analyzer';

let installed = false;

/** Idempotently install the production OCR recognizer + content analyzer. */
export function installOcrEngine(): void {
  if (installed) return;
  installed = true;
  registerOcrRecognizer(() => createTesseractRecognizer());
  registerVisualContentAnalyzer(() => createOcrContentAnalyzer());
}
