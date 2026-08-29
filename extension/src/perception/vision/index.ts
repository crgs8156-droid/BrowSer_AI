// Visual perception entry point (M0 placeholder → M3 implementation).
//
// The M3 pipeline lives in ../visual. This module is kept as a stable import path
// and re-exports it.
//
// The original placeholder exposed `capture(): Promise<ImageData>`, i.e. a raw-frame
// getter. That shape is intentionally NOT implemented: handing raw frames to callers
// invites raw pixels into places they must never reach (logs, messages, remote
// payloads). M3 instead keeps pixels inside the pipeline and returns only derived,
// non-reversible `VisualObservation` labels.

export * from '../visual';

/** @deprecated Use `createVisualPerceptionService()` from `../visual`. */
export interface VisionCollector {
  capture(): Promise<ImageData | null>;
}

/**
 * @deprecated Raw-frame export is deliberately unsupported. Use
 * `createVisualPerceptionService()`, which bounds regions, keeps pixels local, and
 * returns structured observations.
 */
export function createVisionCollector(): VisionCollector {
  return {
    capture(): Promise<ImageData | null> {
      throw new Error(
        'PrivAgent: raw frame export is not supported by design. ' +
          'Use createVisualPerceptionService() from extension/src/perception/visual.',
      );
    },
  };
}
