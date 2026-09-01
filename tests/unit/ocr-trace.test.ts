// Unit tests for the OCR-capture tracer (extension/src/diag/ocr-trace.ts).
//
// The tracer is the ONLY place the visual/OCR pipeline writes diagnostics. Its job is
// to make the capture→OCR→findings→UI path observable in a live browser WITHOUT ever
// logging raw protected content (CONTRIBUTING.md §5 Rule 4, §22). These tests pin: (1) it
// emits under one greppable, content-free prefix; (2) soft failures warn, normal stages
// inform, nothing errors (so the "no console errors" smoke check cannot trip); (3) only
// the safe scalar metadata it is handed is ever printed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ocrTrace } from '../../extension/src/diag/ocr-trace';

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  info.mockRestore();
  warn.mockRestore();
  error.mockRestore();
});

describe('ocrTrace — privacy-safe pipeline diagnostics', () => {
  it('emits normal stages via console.info under the PrivAgent prefix', () => {
    ocrTrace('OCR_REGION_COUNT', { contentFindings: 2, regionsProcessed: 1 });
    expect(info).toHaveBeenCalledTimes(1);
    const [message, detail] = info.mock.calls[0] ?? [];
    expect(String(message)).toBe('[PrivAgent OCR] OCR_REGION_COUNT');
    expect(detail).toEqual({ contentFindings: 2, regionsProcessed: 1 });
  });

  it('routes a soft failure (CAPTURE_FAILED) to console.warn, never console.error', () => {
    ocrTrace('CAPTURE_FAILED', { band: 'viewport', reason: 'VISUAL_CAPTURE_UNAVAILABLE' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('never calls console.error for any stage (smoke-check safe)', () => {
    (
      [
        'SELECTED_PAGE',
        'CAPTURE_REQUESTED',
        'CAPTURE_SUCCESS',
        'CAPTURE_FAILED',
        'PIXEL_DATA_VALID',
        'OCR_STARTED',
        'OCR_RESULT',
        'OCR_REGION_COUNT',
        'PRIVACY_FINDINGS',
        'UI_FINDINGS',
      ] as const
    ).forEach((stage) => ocrTrace(stage, {}));
    expect(error).not.toHaveBeenCalled();
  });

  it('prints only the safe scalar detail it is given (no nested content channel)', () => {
    // The SafeDetail type admits only number/boolean/string — a raw pixel buffer or page
    // text cannot be a value here. We assert the emitted detail is exactly what we passed.
    ocrTrace('PIXEL_DATA_VALID', { regionId: 'r-1', width: 120, height: 48 });
    const [, detail] = info.mock.calls[0] ?? [];
    expect(detail).toEqual({ regionId: 'r-1', width: 120, height: 48 });
    expect(String(message(info))).not.toMatch(/data:image|base64/);
  });
});

function message(spy: ReturnType<typeof vi.spyOn>): unknown {
  return (spy.mock.calls[0] ?? [])[0];
}
