// M7 — PrivAgent-Bench suite (blueprint §10/§11/§7).
//
// Runs the REAL local pipeline over the synthetic fixture pages and produces the
// measured report artifacts under benchmark/reports/ (gitignored). The assertions
// below double as privacy/quality regression gates: a detector or enforcement
// regression that lowers recall, raises false positives, or LEAKS a canary fails CI.
//
//   Golden expectations (v1, documented in docs/benchmark.md):
//   - recall = 1.0 for every category the M2 detector supports (EMAIL, PHONE,
//     PAYMENT/CARD, CREDENTIAL) — NAME/ADDRESS are planted and EXPECTED to be
//     missed by the current detector; their measured recall is reported, not asserted
//   - false-positive rate = 0 over the safe-item controls
//   - redaction precision = 1.0 with zero benign damage on enforced pages
//   - leakage rate = 0 across every page (the sentinel MEASURES this; a non-zero
//     rate fails the suite)

import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fixtures from '../../benchmark/fixtures.json';
import {
  canaryVariants,
  comparisonRow,
  evaluateDetection,
  evaluateRedaction,
  measurePipelineLatency,
  runLeakageProbe,
  type ComparisonRow,
  type Fixtures,
  type LatencyResult,
} from '../../benchmark/run';
import { detectLabeledValues, detectPII } from '../../extension/src/perception/pii';
import { enforcePrivacy } from '../../extension/src/sanitizer';
import { createLocalVault } from '../../extension/src/vault';
import { toSanitizedNodes } from '../../extension/src/agent/loop';

const bench = fixtures as Fixtures;
// Multi-signal detection (pattern + label evidence) covers all five planted categories;
// free-text values WITHOUT a label remain honestly undetectable (see docs/benchmark.md).
const SUPPORTED_CATEGORIES = new Set(['EMAIL', 'PHONE', 'PAYMENT', 'CREDENTIAL', 'NAME', 'ADDRESS']);

const REPORTS_DIR = join(process.cwd(), 'benchmark', 'reports');

interface BenchReport {
  generatedAt: string;
  fixtureVersion: number;
  pages: {
    id: string;
    family: string;
    difficulty: string;
    detection: ReturnType<typeof evaluateDetection>;
    redaction: ReturnType<typeof evaluateRedaction>;
    leakage: { taskCompleted: boolean; runStatus: string; leakageRate: number; leaked: string[]; requestBytes: number };
    latency: LatencyResult;
  }[];
  comparison: ComparisonRow[];
  totals: {
    plantedItems: number;
    detectedItems: number;
    recall: number;
    falsePositiveRate: number;
    leakageRate: number;
    taskSuccessRate: number;
    avgPipelineP50Ms: number;
    avgPrivAgentTextBytes: number;
  };
}

describe('PrivAgent-Bench', () => {
  const report: BenchReport = {
    generatedAt: new Date().toISOString(),
    fixtureVersion: bench.version,
    pages: [],
    comparison: [],
    totals: {
      plantedItems: 0,
      detectedItems: 0,
      recall: 0,
      falsePositiveRate: 0,
      leakageRate: 0,
      taskSuccessRate: 0,
      avgPipelineP50Ms: 0,
      avgPrivAgentTextBytes: 0,
    },
  };

  it('measures recall, false positives, redaction, leakage, latency across all page families', async () => {
    expect(bench.pages.length).toBeGreaterThanOrEqual(8);

    let tasksCompleted = 0;
    let taskEligible = 0;
    let totalLeaked = 0;
    let totalSafe = 0;
    let totalFalsePositives = 0;

    for (const page of bench.pages) {
      // --- detection + redaction (single enforced pass) ---
      const detection = evaluateDetection(page.pageText, page.planted, page.safe);
      const vault = createLocalVault();
      const entities = [...detectPII(page.pageText), ...detectLabeledValues(page.pageText)];
      const enforcement = await enforcePrivacy({
        signals: { entities, restricted: false },
        pageText: page.pageText,
        sessionId: `bench-${page.id}`,
        vault,
      });
      // With multi-signal detection every planted category is coverable.
      const redaction = evaluateRedaction(enforcement.sanitizedText, page.planted, page.safe);

      // Goldens: supported categories must be perfectly recalled; safe items must be untouched.
      for (const row of detection.perCategory) {
        if (SUPPORTED_CATEGORIES.has(row.category)) {
          expect(
            row.recall,
            `${page.id}/${row.category}: supported categories must be fully recalled`,
          ).toBe(1);
        }
      }
      expect(
        detection.falsePositives,
        `${page.id}: safe items must never be flagged`,
      ).toEqual([]);

      // Redaction goldens only when the page was fully enforceable.
      if (enforcement.enforced && !enforcement.blocked) {
        expect(redaction.precision, `${page.id}: redaction precision`).toBe(1);
        expect(redaction.benignDamaged, `${page.id}: benign text must survive`).toEqual([]);
      }

      // --- §7 leakage sentinel: the REAL loop over this page ---
      const probe = await runLeakageProbe(page);
      expect(probe.leakageRate, `${page.id}: measured leakage rate must be zero`).toBe(0);

      // Blueprint §5 decision rule: a page carrying a credential is CRITICAL — the
      // loop must refuse to drive it AT ALL (fail closed, zero outbound requests).
      const hasCredential = page.planted.some((item) => item.category === 'CREDENTIAL');
      if (hasCredential) {
        expect(probe.runStatus, `${page.id}: credential page must be fail-closed blocked`).toBe('blocked');
        expect(probe.requests.length, `${page.id}: blocked page must emit zero requests`).toBe(0);
      } else {
        expect(probe.taskCompleted, `${page.id}: planner must complete the fixture task`).toBe(true);
      }

      // The outbound request must contain the aliases and be firewall-clean by construction.
      const lastRequest = probe.requests[probe.requests.length - 1] ?? '{}';
      for (const item of page.planted) {
        if (SUPPORTED_CATEGORIES.has(item.category)) {
          expect(
            canaryVariants(item.value).some((variant) => lastRequest.includes(variant)),
            `${page.id}: ${item.category} canary must NOT appear in the outbound request`,
          ).toBe(false);
        }
      }

      // --- §10 local inference latency ---
      const latency = await measurePipelineLatency(page, 20);

      // --- §11 comparison row ---
      const aliasCount = enforcement.aliases.length;
      report.comparison.push(comparisonRow(page, enforcement.sanitizedText, aliasCount));

      report.pages.push({
        id: page.id,
        family: page.family,
        difficulty: page.difficulty,
        detection,
        redaction,
        leakage: {
          taskCompleted: probe.taskCompleted,
          runStatus: probe.runStatus,
          leakageRate: probe.leakageRate,
          leaked: probe.leaked.map((entry) => entry.value),
          requestBytes: probe.requestBytes,
        },
        latency,
      });

      report.totals.plantedItems += detection.overall.planted;
      report.totals.detectedItems += detection.overall.detected;
      totalSafe += page.safe.length;
      totalFalsePositives += detection.falsePositives.length;
      totalLeaked += probe.leaked.length;
      if (probe.taskCompleted) tasksCompleted++;
      if (!hasCredential) taskEligible++;
    }

    const pageCount = bench.pages.length;
    report.totals.recall =
      report.totals.plantedItems === 0
        ? 1
        : report.totals.detectedItems / report.totals.plantedItems;
    report.totals.falsePositiveRate = totalSafe === 0 ? 0 : totalFalsePositives / totalSafe;
    report.totals.leakageRate = report.totals.plantedItems === 0 ? 0 : totalLeaked / report.totals.plantedItems;
    report.totals.taskSuccessRate = taskEligible === 0 ? 0 : tasksCompleted / taskEligible;
    report.totals.avgPipelineP50Ms =
      report.pages.reduce((sum, page) => sum + page.latency.p50Ms, 0) / pageCount;
    report.totals.avgPrivAgentTextBytes =
      report.comparison.reduce((sum, row) => sum + row.privAgent.textBytes, 0) / pageCount;

    // ---- §11 headline: PrivAgent preserves slots that full redaction destroys ----
    const redactedSlots = report.comparison.reduce(
      (sum, row) => sum + row.fullRedaction.fillableSensitiveSlots,
      0,
    );
    const privAgentSlots = report.comparison.reduce(
      (sum, row) => sum + row.privAgent.fillableSensitiveSlots,
      0,
    );
    expect(privAgentSlots).toBeGreaterThan(redactedSlots);
  });

  it('writes the report artifacts (json + markdown)', async () => {
    // Re-derive quickly from the collected report (first test populates it).
    mkdirSync(REPORTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(REPORTS_DIR, `bench-${stamp}.json`), JSON.stringify(report, null, 2));
    writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify(report, null, 2));

    const lines: string[] = [
      '# PrivAgent-Bench — measured report',
      '',
      `Generated: ${report.generatedAt} · fixtures v${report.fixtureVersion} · ${bench.pages.length} pages`,
      '',
      '| Metric | Measured |',
      '| --- | --- |',
      `| PII recall (all planted categories) | ${(report.totals.recall * 100).toFixed(1)}% (${report.totals.detectedItems}/${report.totals.plantedItems}) |`,
      `| False-positive rate (safe controls) | ${(report.totals.falsePositiveRate * 100).toFixed(1)}% |`,
      `| Leakage rate (§7 sentinel) | ${(report.totals.leakageRate * 100).toFixed(1)}% |`,
      `| Task success rate (deterministic planner, non-credential pages) | ${(report.totals.taskSuccessRate * 100).toFixed(0)}% |`,
      `| Local inference latency (p50) | ${report.totals.avgPipelineP50Ms.toFixed(2)} ms |`,
      `| Avg PrivAgent sanitized text size | ${report.totals.avgPrivAgentTextBytes.toFixed(0)} B |`,
      '',
      '## Per-page detection recall',
      '',
      '| Page | Difficulty | ' + 'Category recalls |',
      '| --- | --- | --- |',
    ];
    for (const page of report.pages) {
      const recalls = page.detection.perCategory
        .map((row) => `${row.category} ${(row.recall * 100).toFixed(0)}%`)
        .join(' · ');
      lines.push(`| ${page.id} | ${page.difficulty} | ${recalls} |`);
    }
    lines.push(
      '',
      '## §11 three-way comparison (payload bytes / fillable sensitive slots)',
      '',
      '| Page | No protection | Full redaction | PrivAgent |',
      '| --- | --- | --- | --- |',
    );
    for (const row of report.comparison) {
      lines.push(
        `| ${row.pageId} | ${row.noProtection.textBytes} B / ${row.noProtection.fillableSensitiveSlots} slots | ${row.fullRedaction.textBytes} B / ${row.fullRedaction.fillableSensitiveSlots} slots | ${row.privAgent.textBytes} B / ${row.privAgent.fillableSensitiveSlots} slots |`,
      );
    }
    lines.push(
      '',
      'All planted categories are detected via multi-signal detection (patterns + label evidence). Free-text values without an introducing label remain out of scope — see docs/benchmark.md.',
      '',
    );
    writeFileSync(join(REPORTS_DIR, 'latest.md'), lines.join('\n'));

    expect(report.pages.length).toBe(bench.pages.length);
  });
});

// toSanitizedNodes is re-verified here so the request-side gate is inside the bench too.
describe('bench request-side gate', () => {
  it('never places raw values into SanitizedNodes for bench fixtures', () => {
    for (const page of bench.pages) {
      const nodes = toSanitizedNodes(
        page.structure.map((field) => ({ ...field, disabled: false, value: undefined })),
      );
      for (const node of nodes) {
        expect(JSON.stringify(node)).not.toMatch(/BENCH_/);
      }
    }
  });
});
