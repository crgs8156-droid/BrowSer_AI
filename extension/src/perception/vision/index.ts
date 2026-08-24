// Visual capture (blueprint §5). Uses Chrome tab/screen capture APIs. Implemented in M3.
export interface VisionCollector {
  capture(): Promise<ImageData | null>;
}

export function createVisionCollector(): VisionCollector {
  return {
    capture() {
      throw new Error('PrivAgent: VisionCollector.capture not implemented (M3).');
    },
  };
}
