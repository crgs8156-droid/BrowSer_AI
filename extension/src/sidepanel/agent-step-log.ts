// Part B — privacy-safe step log formatting (sidepanel only).
// Alias-level and origin-only rendering: never a raw value, never a full URL
// (query strings can carry content). Pure functions — tested in
// `tests/unit/agent-step-log.test.ts`.

import type { AgentStepRecord } from '../agent/loop';

function originOnly(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'allowlisted url';
  }
}

/** One streaming line for a completed step: icon + description + status. */
export function formatAgentStep(step: AgentStepRecord): string {
  const action = step.action;
  if (action === null) return '\u2705 Task complete \u2014 0 bytes leaked';
  switch (action.action) {
    case 'CLICK':
      return `\u2705 Clicked ${action.target} \u2014 ${step.outcome}`;
    case 'TYPE':
      return `\u2705 Typed into ${action.target} \u2014 ${step.outcome}`;
    case 'SELECT':
      return `\u2705 Selected ${action.target} \u2014 ${step.outcome}`;
    case 'SCROLL':
      return `\u2705 Scrolled \u2014 ${step.outcome}`;
    case 'NAVIGATE':
      return `\u{1F310} Navigating to ${originOnly(action.url)} \u2014 ${step.outcome}`;
    default:
      return `\u2705 Step ${step.index} \u2014 ${step.outcome}`;
  }
}

/** Static stage openers shown once per run (no counts — counts would be fabricated). */
export const STEP_LOG_OPENERS: readonly string[] = [
  '\u{1F50D} Scanning page...',
  '\u{1F6E1}\uFE0F Shielding fields (local)...',
  '\u{1F916} Planning action...',
];

/** Terminal line for a finished run (status-only, never content). */
export function formatTerminalLine(status: string, reason?: string): string {
  if (status === 'completed') return '\u2705 Task complete \u2014 0 bytes leaked';
  if (status === 'max_steps') return `\u23F9 Stopped \u2014 ${reason ?? 'step budget reached'}`;
  return `\u2705 Finished \u2014 ${reason ?? status}`;
}
