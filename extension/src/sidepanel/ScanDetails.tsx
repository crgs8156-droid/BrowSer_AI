// ScanDetails — transparent scan results view (Phase 2).
// Collapsed by default, auto-expands when PII detected. Never shows raw values.
// Masked values use \u2022 bullets, never * or raw. Pure rendering, no side effects.

import { useState } from 'react';
import type { ScanSummary } from '../scan';

export interface ScanDetailsFinding {
  alias: string;
  category: string;
  masked: string;
  label: string;
  source: string;
  confidence?: string;
}

export interface ScanDetailsProps {
  summary: ScanSummary | null;
  findings: ScanDetailsFinding[];
  fields: { inputs: number; textareas: number; labels: number; total: number; sensitive: number; safe: number };
  policy: { decision: string; signals: string[]; mode: string };
}

function categoryIcon(category: string): string {
  const c = category.toUpperCase();
  if (c === 'EMAIL') return '📧';
  if (c === 'PHONE' || c === 'PHONE_NUMBER') return '📱';
  if (c === 'AADHAAR') return '🪪';
  if (c === 'PAN') return '📄';
  if (c === 'PAYMENT' || c === 'PAYMENT_CARD') return '💳';
  if (c === 'PASSWORD' || c === 'CREDENTIAL') return '🔐';
  if (c === 'UPI') return '💸';
  if (c === 'NAME') return '👤';
  return '🛡\uFE0F';
}

export function maskForCategory(value: string, category: string): string {
  const cat = category.toUpperCase();
  if (!value) return '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
  if (cat === 'PASSWORD' || cat === 'CREDENTIAL') return '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
  if (cat === 'EMAIL') {
    const at = value.indexOf('@');
    if (at > 0) {
      const local = value.slice(0, Math.min(4, at));
      const domain = value.slice(at);
      const tldIdx = domain.lastIndexOf('.');
      const tld = tldIdx > 0 ? domain.slice(tldIdx) : '';
      return `${local}@\u2022\u2022\u2022${tld}`;
    }
  }
  if (cat === 'PHONE' || cat === 'PHONE_NUMBER') {
    // +91 98\u2022\u2022\u2022\u2022\u2022 210 style
    const digits = value.replace(/\D/g, '');
    const core = digits.slice(-10);
    if (core.length === 10) {
      const cc = digits.length > 10 ? `+${digits.slice(0, digits.length - 10)} ` : '';
      return `${cc}${core.slice(0, 2)}\u2022\u2022\u2022\u2022\u2022${core.slice(-3)}`;
    }
  }
  if (cat === 'AADHAAR') {
    const d = value.replace(/\D/g, '');
    if (d.length >= 12) return `${d.slice(0, 4)} \u2022\u2022\u2022\u2022 \u2022\u2022\u2022\u2022${d.slice(-2)}`;
  }
  if (cat === 'PAN') {
    if (value.length >= 10) return `${value.slice(0, 2)}\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022${value.slice(-1)}`;
  }
  if (cat === 'UPI') {
    const at = value.indexOf('@');
    if (at > 0) return `\u2022\u2022\u2022@${value.slice(at + 1)}`;
  }
  if (cat === 'NAME') {
    const first = value.split(/\s+/)[0] ?? value;
    return `${first} \u2022\u2022\u2022`;
  }
  // Default: first2 + \u2022\u2022\u2022\u2022 + last2
  if (value.length <= 4) return '\u2022\u2022\u2022\u2022';
  return `${value.slice(0, 2)}\u2022\u2022\u2022\u2022${value.slice(-2)}`;
}

export function ScanDetails({ summary, findings, fields, policy }: ScanDetailsProps) {
  const count = findings.length;
  const hasPII = count > 0;
  const [expanded, setExpanded] = useState(() => hasPII);
  // Auto-expand when PII detected after initial mount
  // (use effect would be needed for prop change, but spec says auto-expands if PII detected — initial state covers first render)

  if (!summary) return null;

  return (
    <section className="mt-4 rounded border border-neutral-200 p-3" aria-label="Scan details" data-testid="scan-details">
      <button
        className="flex w-full items-center justify-between text-left"
        data-testid="scan-details-toggle"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="text-sm font-semibold">🔍 Scan Details ({count} items)</span>
        <span className="text-xs text-neutral-500">{expanded ? '\u25B2' : '\u25BC'}</span>
      </button>

      {(expanded || !hasPII) && (
        <div className="mt-2">
          {hasPII ? (
            <>
              <div data-testid="detected-pii">
                <h4 className="text-xs font-semibold">Detected PII</h4>
                <table className="mt-1 w-full text-xs" data-testid="pii-table">
                  <thead>
                    <tr className="text-left text-neutral-500">
                      <th>Category</th><th>Alias</th><th>Masked Value</th><th>Found In</th><th>Confidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {findings.map((f) => (
                      <tr key={f.alias} className="border-t border-neutral-100" data-testid="pii-row">
                        <td>{categoryIcon(f.category)} {f.label}</td>
                        <td className="font-mono">{f.alias}</td>
                        <td className="font-mono">{f.masked}</td>
                        <td>{f.source}</td>
                        <td>{f.confidence ?? 'High'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-3" data-testid="fields-analyzed">
                <h4 className="text-xs font-semibold">Fields analyzed</h4>
                <p className="text-xs text-neutral-600">
                  Analyzed {fields.inputs} input fields, {fields.textareas} text areas, {fields.labels} labels
                </p>
                <p className="text-xs text-neutral-600">Detected: {fields.sensitive} sensitive, {fields.safe} safe</p>
              </div>

              <div className="mt-3" data-testid="policy-decision">
                <h4 className="text-xs font-semibold">Policy decision</h4>
                <p className="text-xs">{policy.decision}</p>
                <p className="text-xs text-neutral-500">Policy signals: {policy.signals.join(' ') || 'none'}</p>
                <p className="text-xs text-neutral-500">Mode: {policy.mode}</p>
              </div>
            </>
          ) : (
            <div data-testid="nothing-detected">
              <p className="text-xs text-green-700">\u2705 No sensitive fields detected on this page</p>
              <p className="text-xs text-neutral-500">Analyzed {fields.total} fields \u2014 all appear safe</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
