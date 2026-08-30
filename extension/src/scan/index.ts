// Scan summary — public entry point.
//
// `buildScanSummary` reduces an M5 `EnforcementResult` into the display-safe
// `ScanSummary` the side panel renders (aliases, region metadata, counts — never a raw
// value or page content). See ./summary.ts for the privacy rationale.

export { buildScanSummary } from './summary';
export type {
  ScanSummary,
  ScanFindingView,
  ScanFindingKind,
  ScanStatus,
} from './summary';
