// OCR perception (blueprint §5). Browser-runnable OCR (candidate: tesseract.js).
// Implemented in M3.
export interface OcrResult {
  text: string;
  bbox: [number, number, number, number];
  confidence: number;
}

export interface OcrEngine {
  recognize(_image: ImageData): Promise<OcrResult[]>;
}

export function createOcrEngine(): OcrEngine {
  return {
    recognize() {
      throw new Error('PrivAgent: OcrEngine.recognize not implemented (M3).');
    },
  };
}
