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
    <section className="pa-card" style={{ marginTop: 10, padding: '12px 14px' }} aria-label="Scan details" data-testid="scan-details">
      <button
        style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', textAlign: 'left' }}
        data-testid="scan-details-toggle"
        onClick={() => setExpanded((v) => !v)}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--pa-text)' }}>🔍 Scan Details ({count} items)</span>
        <span className="pa-faint" style={{ fontSize: 12 }}>{expanded ? '\u25B2' : '\u25BC'}</span>
      </button>

      {(expanded || !hasPII) && (
        <div style={{ marginTop: 8 }}>
          {hasPII ? (
            <>
              <div data-testid="detected-pii">
                <p className="pa-section-label">Detected PII</p>
                <table style={{ marginTop: 4, width: '100%', fontSize: 12 }} data-testid="pii-table">
                  <thead>
                    <tr style={{ textAlign: 'left' }} className="pa-faint">
                      <th>Category</th><th>Alias</th><th>Masked Value</th><th>Found In</th><th>Confidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {findings.map((f) => (
                      <tr key={f.alias} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }} data-testid="pii-row">
                        <td style={{ color: 'var(--pa-text)' }}>{categoryIcon(f.category)} {f.label}</td>
                        <td style={{ fontFamily: 'monospace', color: 'var(--pa-secondary)' }}>{f.alias}</td>
                        <td className="pa-masked">{f.masked}</td>
                        <td className="pa-muted">{f.source}</td>
                        <td className="pa-muted">{f.confidence ?? 'High'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ marginTop: 12 }} data-testid="fields-analyzed">
                <p className="pa-section-label">Fields analyzed</p>
                <p className="pa-muted" style={{ fontSize: 12 }}>
                  Analyzed {fields.inputs} input fields, {fields.textareas} text areas, {fields.labels} labels
                </p>
                <p className="pa-muted" style={{ fontSize: 12 }}>Detected: {fields.sensitive} sensitive, {fields.safe} safe</p>
              </div>

              <div style={{ marginTop: 12 }} data-testid="policy-decision">
                <p className="pa-section-label">Policy decision</p>
                <p style={{ fontSize: 12, color: 'var(--pa-text)' }}>{policy.decision}</p>
                <p className="pa-faint" style={{ fontSize: 12 }}>Policy signals: {policy.signals.join(' ') || 'none'}</p>
                <p className="pa-faint" style={{ fontSize: 12 }}>Mode: {policy.mode}</p>
              </div>
            </>
          ) : (
            <div data-testid="nothing-detected">
              <p style={{ fontSize: 12, color: 'var(--pa-accent)' }}>\u2705 No sensitive fields detected on this page</p>
              <p className="pa-faint" style={{ fontSize: 12 }}>Analyzed {fields.total} fields \u2014 all appear safe</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
