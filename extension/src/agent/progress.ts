// Safe progress fingerprint for no-progress detection (no PII, no vault values, no OCR content).
// Uses sanitized structure only: selector presence, filled flags, origin, action type/target.

import type { SanitizedNode } from '../types/contracts';
import type { AgentAction } from '../types/contracts';

function actionTarget(action: AgentAction): string {
  if (action.action === 'NAVIGATE') return action.url;
  if (action.action === 'SCROLL') return String(action.amount);
  return action.target;
}

export function getProgressFingerprint(
  sanitizedNodes: SanitizedNode[],
  pageOrigin: string | undefined,
  lastAction: AgentAction | null,
): string {
  const parts: string[] = [];
  parts.push(pageOrigin ?? 'unknown');
  for (const node of sanitizedNodes) {
    parts.push(`${node.tag}:${node.selector}:${node.filled ? '1' : '0'}:${node.disabled ? '1' : '0'}`);
  }
  if (lastAction) {
    parts.push(`action:${lastAction.action}:${actionTarget(lastAction)}`);
  }
  // Simple hash: join and return string (no crypto needed, just comparison)
  return parts.join('|');
}
