// OCR → sensitivity content analyzer.
//
// Bridges the M3 OCR boundary (../ocr) to the visual-perception pipeline's
// content-analyzer contract (./types, ./content-analyzer). Given decoded pixels for
// ONE bounded region it:
//   1. runs the registered local OCR recognizer over the raster (no network),
//   2. reassembles word boxes into a single text surface with per-word offsets,
//   3. classifies that text with the SAME M2 detector used for the DOM (detectPII),
//   4. maps each detected value back to the union of the word boxes it covers,
//   5. emits categorized `RawVisualContentFinding`s in RASTER pixel coordinates.
//
// HONESTY (CLAUDE.md §22):
//   - No OCR recognizer registered  → status `not_available`, zero findings.
//   - Recognizer errors / cannot load → status `failed`, zero findings.
//   - Recognizer runs but reads nothing → status `ok`, zero findings.
// A finding is only ever produced from text the engine ACTUALLY recognized.
//
// PRIVACY: recognized text is raw protected content. It is used locally to classify
// and is attached to the finding for local aliasing only; it is never logged and
// never crosses the remote boundary without sanitization (CLAUDE.md §5).

import { detectPII } from '../pii';
import { toSensitiveCategory } from '../../sanitizer/alias';
import { createOcrEngine, isOcrAvailable, type OcrResult } from '../ocr';
import type {
  RawVisualContentFinding,
  VisualBackend,
  VisualContentAnalyzer,
  VisualContentAnalyzerResult,
  RasterRegion,
} from './types';
import type { VisualRegion } from '../../types/contracts';

/** Union of a set of [x, y, w, h] boxes; null when the set is empty. */
function unionBox(
  boxes: [number, number, number, number][],
): [number, number, number, number] | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y, w, h] of boxes) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }
  return [minX, minY, Math.max(0, maxX - minX), Math.max(0, maxY - minY)];
}

/** Parse the character offset the M2 detector encodes into each entity id (`email-123`). */
function entityStart(id: string): number | null {
  const tail = id.split('-').pop();
  if (tail === undefined) return null;
  const n = Number.parseInt(tail, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Turn recognized words into one text surface plus a parallel array recording each
 * word's [start, end) offset in that surface. Words are joined with single spaces,
 * matching how the M2 phone/email/credential regexes expect tokens to be separated.
 */
function assemble(words: OcrResult[]): {
  text: string;
  spans: { start: number; end: number; box: [number, number, number, number]; conf: number }[];
} {
  const spans: {
    start: number;
    end: number;
    box: [number, number, number, number];
    conf: number;
  }[] = [];
  let text = '';
  for (const word of words) {
    const start = text.length;
    text += word.text;
    spans.push({ start, end: text.length, box: word.bbox, conf: word.confidence });
    text += ' ';
  }
  return { text, spans };
}

/**
 * Build the OCR content analyzer. Provider-agnostic: it uses whatever recognizer is
 * registered in ../ocr, so tests can inject a fake engine while production uses the
 * real Tesseract recognizer. Constructs nothing heavy itself.
 */
export function createOcrContentAnalyzer(): VisualContentAnalyzer {
  const engine = createOcrEngine();

  return {
    name: 'ocr',
    source: 'OCR',
    async analyze(
      raster: RasterRegion,
      _region: VisualRegion,
      _backend: VisualBackend,
    ): Promise<VisualContentAnalyzerResult> {
      // No recognizer registered → be honest, never fabricate.
      if (!isOcrAvailable()) return { status: 'not_available', findings: [] };

      let words: OcrResult[];
      try {
        words = await engine.recognize(raster);
      } catch {
        // Engine present but failed to load/run — fail closed for this region.
        return { status: 'failed', findings: [] };
      }

      if (words.length === 0) return { status: 'ok', findings: [] };

      const { text, spans } = assemble(words);
      const entities = detectPII(text);

      const findings: RawVisualContentFinding[] = [];
      for (const entity of entities) {
        const value = entity.text ?? '';
        const start = entityStart(entity.id);
        if (start === null || value.length === 0) continue;
        const end = start + value.length;

        // Every word box overlapping the matched span contributes to the mask box.
        const covering = spans.filter((s) => s.start < end && s.end > start);
        const box = unionBox(covering.map((s) => s.box));
        if (box === null) continue;

        // Confidence reflects the OCR reading, not the (always-1) regex certainty.
        const conf =
          covering.reduce((sum, s) => sum + s.conf, 0) / Math.max(1, covering.length);

        findings.push({
          category: toSensitiveCategory(String(entity.category)),
          confidence: Math.max(0, Math.min(1, conf)),
          bbox: box,
          text: value,
        });
      }

      return { status: 'ok', findings };
    },
  };
}
