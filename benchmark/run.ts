// M7 — PrivAgent-Bench evaluation core (blueprint §10/§11/§7).
//
// Pure, dependency-free functions the benchmark suite drives:
//   - evaluateDetection : PII recall per category + false-positive rate over safe items
//   - evaluateRedaction : redaction precision (planted values gone, benign text intact)
//   - runLeakageProbe   : the §7 leakage sentinel — runs the REAL agent loop over a
//                         fixture page and searches every outbound payload for canary
//                         values and robust variants (case/URL-encoding)
//   - comparisonPayloads: the §11 three-way comparison — no-protection vs full-redaction
//                         vs PrivAgent — as byte counts and fillable task slots
//
// PRIVACY: fixtures are synthetic and uniquely identifiable (Invariant 6); nothing here
// performs network I/O; reports carry values only because they ARE the synthetic values.

import { detectLabeledValues, detectPII } from '../extension/src/perception/pii';
import { enforcePrivacy } from '../extension/src/sanitizer';
import { createLocalVault } from '../extension/src/vault';
import { createPrivacyFirewall } from '../extension/src/firewall';
import { createDeterministicPlanner } from '../extension/src/agent/planner';
import { createActionBridge } from '../extension/src/actions';
import { runAgentLoop } from '../extension/src/agent/loop';
import { redact } from '../extension/src/sanitizer/alias';
import type { AgentAction, RemoteAgentRequest } from '../extension/src/types/contracts';
import type { FieldStructure, ScanPageResponse } from '../extension/src/types/messages';

// ---------------------------------------------------------------------------
// Fixture shapes (mirror benchmark/fixtures.json)
// ---------------------------------------------------------------------------

export interface PlantedItem {
  category: string;
  value: string;
}

export interface RawField {
  tag: 'input' | 'textarea' | 'select' | 'button';
  selector: string;
  inputType?: string;
  label?: string;
  name?: string;
}

export interface PageFixture {
  id: string;
  family: string;
  difficulty: 'easy' | 'medium' | 'hard';
  task: string;
  pageText: string;
  structure: RawField[];
  planted: PlantedItem[];
  safe: string[];
}

export interface Fixtures {
  version: number;
  note: string;
  pages: PageFixture[];
}

// ---------------------------------------------------------------------------
// Matching helpers — exact for EMAIL, normalized for separators, containment for
// CREDENTIAL (the detector's entity text includes the `keyword: value` prefix).
// ---------------------------------------------------------------------------

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s-]/g, '');
}

export function isDetected(detectedText: string, planted: string): boolean {
  const a = normalize(detectedText);
  const b = normalize(planted);
  return a === b || a.includes(b) || b.includes(a);
}

/** §7 robust variants: exact, case-folded, URL-encoded. */
export function canaryVariants(value: string): string[] {
  const variants = new Set<string>([value, value.toLowerCase()]);
  try {
    variants.add(encodeURIComponent(value));
    variants.add(encodeURIComponent(value).toLowerCase());
  } catch {
    // value is already a plain string; encoding is best-effort
  }
  return [...variants];
}

// ---------------------------------------------------------------------------
// Detection metrics (blueprint §10: PII recall, false-positive rate)
// ---------------------------------------------------------------------------

export interface CategoryRecall {
  category: string;
  planted: number;
  detected: number;
  recall: number;
}

export interface DetectionEvaluation {
  perCategory: CategoryRecall[];
  overall: { planted: number; detected: number; recall: number };
  /** Safe items the detector flagged — each one is a false positive. */
  falsePositives: string[];
  falsePositiveRate: number;
  /** Detected entities matching NO planted item (informational samples). */
  unmatchedSamples: string[];
}

export function evaluateDetection(
  pageText: string,
  planted: PlantedItem[],
  safe: string[],
): DetectionEvaluation {
  // Multi-signal: the SAME combination the agent loop uses (patterns + label evidence).
  const entities = [...detectPII(pageText), ...detectLabeledValues(pageText)];
  const detectedTexts = entities.map((entity) => entity.text ?? '');

  const perCategory: CategoryRecall[] = [];
  let totalPlanted = 0;
  let totalDetected = 0;

  const categories = [...new Set(planted.map((item) => item.category))];
  for (const category of categories) {
    const items = planted.filter((item) => item.category === category);
    const detected = items.filter((item) =>
      detectedTexts.some((text) => isDetected(text, item.value)),
    ).length;
    perCategory.push({
      category,
      planted: items.length,
      detected,
      recall: items.length === 0 ? 1 : detected / items.length,
    });
    totalPlanted += items.length;
    totalDetected += detected;
  }

  const falsePositives = safe.filter((item) => detectPII(item).length > 0);
  const unmatched = detectedTexts.filter(
    (text) => !planted.some((item) => isDetected(text, item.value)),
  );

  return {
    perCategory,
    overall: {
      planted: totalPlanted,
      detected: totalDetected,
      recall: totalPlanted === 0 ? 1 : totalDetected / totalPlanted,
    },
    falsePositives,
    falsePositiveRate: safe.length === 0 ? 0 : falsePositives.length / safe.length,
    unmatchedSamples: unmatched.slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Redaction metrics (rubric: precision of redaction — planted values gone,
// benign text intact)
// ---------------------------------------------------------------------------

export interface RedactionEvaluation {
  planted: number;
  removed: number;
  missed: string[];
  /** Safe items damaged or removed by redaction — each is a redaction error. */
  benignDamaged: string[];
  precision: number;
}

export function evaluateRedaction(
  sanitizedText: string,
  planted: PlantedItem[],
  safe: string[],
): RedactionEvaluation {
  const missed = planted.filter((item) => sanitizedText.includes(item.value)).map((i) => i.value);
  const benignDamaged = safe.filter((item) => !sanitizedText.includes(item));
  const removed = planted.length - missed.length;
  return {
    planted: planted.length,
    removed,
    missed,
    benignDamaged,
    precision: planted.length === 0 ? 1 : removed / planted.length,
  };
}

// ---------------------------------------------------------------------------
// §11 three-way comparison — payload bytes + fillable task slots
// ---------------------------------------------------------------------------

export interface ComparisonRow {
  pageId: string;
  noProtection: { textBytes: number; fillableSensitiveSlots: number };
  fullRedaction: { textBytes: number; fillableSensitiveSlots: number };
  privAgent: { textBytes: number; fillableSensitiveSlots: number; aliasCount: number };
}

export function comparisonRow(
  page: PageFixture,
  sanitizedText: string,
  aliasCount: number,
): ComparisonRow {
  const plantedCount = page.planted.length;
  const redactedText = redact(
    page.pageText,
    page.planted.map((item) => ({ value: item.value, alias: '[REDACTED]' })),
  );
  return {
    pageId: page.id,
    noProtection: {
      textBytes: Buffer.byteLength(page.pageText, 'utf8'),
      fillableSensitiveSlots: plantedCount,
    },
    fullRedaction: {
      textBytes: Buffer.byteLength(redactedText, 'utf8'),
      fillableSensitiveSlots: 0,
    },
    privAgent: {
      textBytes: Buffer.byteLength(sanitizedText, 'utf8'),
      fillableSensitiveSlots: aliasCount,
      aliasCount,
    },
  };
}

// ---------------------------------------------------------------------------
// §7 leakage sentinel — the REAL loop over a fixture page
// ---------------------------------------------------------------------------

export interface LeakageProbeResult {
  pageId: string;
  taskCompleted: boolean;
  runStatus: string;
  encountered: number;
  leaked: { value: string; where: string }[];
  leakageRate: number;
  requestBytes: number;
  requests: string[];
}

/**
 * Drives `runAgentLoop` over one fixture page (fake scan/executor backed by mutable
 * state, REAL enforcement/firewall/planner/bridge), captures every outbound request,
 * and searches payloads + step records for canary variants. Leakage rate is MEASURED,
 * not asserted — a non-zero rate is a benchmark finding, not a test-harness failure.
 */
export async function runLeakageProbe(page: PageFixture): Promise<LeakageProbeResult> {
  const values = new Map<string, string>();
  let submitted = false;
  const requests: string[] = [];

  const scan = async (): Promise<ScanPageResponse> => ({
    pageText: [
      page.pageText,
      ...page.structure
        .filter((field) => field.tag !== 'button')
        .map((field) => values.get(field.selector) ?? ''),
    ]
      .filter((part) => part.length > 0)
      .join('\n'),
    snapshot: null,
    structure: page.structure.map((field) => ({
      ...field,
      disabled: field.tag === 'button' && submitted,
      value: values.get(field.selector) || undefined,
    })) satisfies FieldStructure[],
  });

  const executor = async (action: AgentAction) => {
    if (action.action === 'TYPE' || action.action === 'SELECT') {
      values.set(action.target, action.value);
      return { ok: true, code: 'OK' };
    }
    if (action.action === 'CLICK') {
      submitted = true;
      return { ok: true, code: 'OK' };
    }
    return { ok: false, code: 'NOT_FOUND' };
  };

  const vault = createLocalVault();
  const planner = createDeterministicPlanner();
  const gateway = {
    plan: async (request: RemoteAgentRequest) => {
      requests.push(JSON.stringify(request));
      return planner.plan(request);
    },
  };

  const result = await runAgentLoop({
    task: page.task,
    sessionId: `bench-${page.id}`,
    vault,
    gateway,
    bridge: createActionBridge({ vault, sendToPage: executor }),
    firewall: createPrivacyFirewall(),
    scan,
  });

  const haystacks: { where: string; text: string }[] = [
    ...requests.map((text, index) => ({ where: `request[${index}]`, text })),
    { where: 'step-records', text: JSON.stringify(result.steps) },
  ];

  const leaked: { value: string; where: string }[] = [];
  for (const item of page.planted) {
    for (const variant of canaryVariants(item.value)) {
      for (const { where, text } of haystacks) {
        if (text.includes(variant)) {
          leaked.push({ value: item.value, where });
        }
      }
    }
  }
  const uniqueLeaked = leaked.filter(
    (entry, index) => leaked.findIndex((other) => other.value === entry.value) === index,
  );

  return {
    pageId: page.id,
    taskCompleted: result.status === 'completed',
    runStatus: result.status,
    encountered: page.planted.length,
    leaked: uniqueLeaked,
    leakageRate: page.planted.length === 0 ? 0 : uniqueLeaked.length / page.planted.length,
    requestBytes: requests.reduce((total, text) => total + Buffer.byteLength(text, 'utf8'), 0),
    requests,
  };
}

// ---------------------------------------------------------------------------
// Local inference latency (blueprint §10) — detect + enforce over one page
// ---------------------------------------------------------------------------

export interface LatencyResult {
  pageId: string;
  iterations: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export async function measurePipelineLatency(
  page: PageFixture,
  iterations = 30,
): Promise<LatencyResult> {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const vault = createLocalVault();
    const startedAt = performance.now();
    const entities = detectPII(page.pageText);
    await enforcePrivacy({
      signals: { entities, restricted: false },
      pageText: page.pageText,
      sessionId: `latency-${page.id}-${index}`,
      vault,
    });
    samples.push(performance.now() - startedAt);
  }
  const sorted = samples.slice().sort((a, b) => a - b);
  const pick = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
  return {
    pageId: page.id,
    iterations,
    p50Ms: pick(50),
    p95Ms: pick(95),
    maxMs: sorted.at(-1) ?? 0,
  };
}
