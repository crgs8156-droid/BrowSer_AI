export interface OcrResult {
  text: string;
  confidence: number;
  bbox: [number, number, number, number];
}

export interface OcrEngine {
  recognize(image: any): Promise<OcrResult[]>;
}

export function createOcrEngine(): OcrEngine {
  return {
    async recognize(image: any): Promise<OcrResult[]> {
      if (!image) {
        return [];
      }

      return [
        {
          text: 'Sample OCR Text',
          confidence: 0.95,
          bbox: [0, 0, 100, 20],
        },
      ];
    },
  };
}