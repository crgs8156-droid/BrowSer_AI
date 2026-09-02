import { describe, expect, it, vi } from 'vitest';
import {
  blurRegions,
  createFaceBlurEngine,
  parseDetections,
  preprocessRaster,
  type FaceSessionLike,
  type OrtValueLike,
} from '../../../../extension/src/perception/visual/faceBlur';

function raster(width = 64, height = 64): { width: number; height: number; data: Uint8ClampedArray } {
  return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(200) };
}

function detectionRow(y1: number, x1: number, y2: number, x2: number): number[] {
  return [y1, x1, y2, x2, ...new Array(12).fill(0.5)];
}

function sessionWithRows(rows: number[][]): FaceSessionLike {
  const output: OrtValueLike = { data: new Float32Array(rows.flat()), dims: [1, rows.length, 16] };
  return {
    inputNames: ['image', 'conf_threshold', 'max_detections', 'iou_threshold'],
    run: vi.fn(async () => ({ selectedBoxes: output })),
  };
}

describe('preprocessRaster', () => {
  it('produces NCHW [1,3,128,128] with [-1,1] RGB normalization', () => {
    const input = raster(2, 2);
    input.data[0] = 255; // first pixel red=255 → (255/127.5)-1 = 1.0
    input.data[1] = 0;
    input.data[2] = 0;
    const tensor = preprocessRaster(input);
    expect(tensor.length).toBe(3 * 128 * 128);
    expect(tensor[0]).toBeCloseTo(1.0); // R plane, first pixel
    expect(tensor[128 * 128]).toBeCloseTo(-1.0); // G plane, first pixel
    expect(tensor[2 * 128 * 128]).toBeCloseTo(-1.0); // B plane, first pixel
  });
});

describe('parseDetections', () => {
  it('scales normalized boxes into raster space', () => {
    const output: OrtValueLike = {
      data: new Float32Array(detectionRow(0.0, 0.0, 0.5, 0.5)),
      dims: [1, 1, 16],
    };
    const regions = parseDetections(output, 100, 200);
    expect(regions).toEqual([{ x: 0, y: 0, width: 50, height: 100 }]);
  });

  it('drops out-of-range and degenerate boxes instead of guessing', () => {
    const output: OrtValueLike = {
      data: new Float32Array([...detectionRow(0.9, 0.9, 1.5, 1.5), ...detectionRow(0.5, 0.5, 0.5, 0.5)]),
      dims: [1, 2, 16],
    };
    expect(parseDetections(output, 100, 100)).toEqual([]);
  });
});

describe('blurRegions', () => {
  it('blacks out exactly the clamped region pixels', () => {
    const input = raster(10, 10);
    const blurred = blurRegions(input, [{ x: 2, y: 2, width: 4, height: 4 }]);
    expect(blurred).toBe(1);
    expect(input.data[(2 * 10 + 2) * 4]).toBe(0);
    expect(input.data[(2 * 10 + 2) * 4 + 3]).toBe(255); // alpha kept inside the region
    expect(input.data[(6 * 10 + 6) * 4]).toBe(200); // outside is untouched
    expect(input.data[(1 * 10 + 2) * 4]).toBe(200); // row above untouched
  });
});

describe('face-blur engine (mocked ONNX session — WASM cannot run in Vitest)', () => {
  it('blurs every detected face reported by the session', async () => {
    const engine = createFaceBlurEngine({
      createSession: async () => sessionWithRows([detectionRow(0, 0, 0.5, 0.5), detectionRow(0.5, 0.5, 1, 1)]),
    });
    const input = raster(100, 100);
    const result = await engine.blur(input);
    expect(result).toEqual({ facesDetected: 2, facesBlurred: 2 });
    expect(input.data[(75 * 100 + 75) * 4]).toBe(0); // inside second face rect
  });

  it('feeds the 0.7 confidence threshold to the graph input', async () => {
    const session = sessionWithRows([]);
    const engine = createFaceBlurEngine({ createSession: async () => session });
    await engine.blur(raster());
    const firstCall = (session.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? {};
    const feeds = firstCall as Record<string, OrtValueLike>;
    expect(Number(feeds['conf_threshold']?.data[0])).toBeCloseTo(0.7);
  });

  it('continues the pipeline with zero faces when the model fails to load', async () => {
    const engine = createFaceBlurEngine({
      createSession: async () => {
        throw new Error('model file missing');
      },
    });
    const input = raster(32, 32);
    const result = await engine.blur(input);
    expect(result).toEqual({ facesDetected: 0, facesBlurred: 0 });
    expect(input.data[0]).toBe(200); // raster untouched
    // Subsequent calls degrade instantly (availability remembered, no retry spam).
    expect(await engine.blur(input)).toEqual({ facesDetected: 0, facesBlurred: 0 });
  });
});
