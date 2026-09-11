// Risk classification for actions (low/medium/high).
// Uses safe, generic heuristics on selector/label and value presence.

import type { AgentAction } from '../types/contracts';

const HIGH_KEYWORDS = /(submit|purchase|buy|pay|delete|remove|transfer|send|publish|post)/i;
const MEDIUM_KEYWORDS = /(download|add to cart|select|payment)/i;

export type RiskLevel = 'low' | 'medium' | 'high';

export function classifyRisk(action: AgentAction): RiskLevel {
  if (action.action === 'NAVIGATE') return 'low';
  if (action.action === 'SCROLL') return 'low';
  if (action.action === 'SELECT') return 'medium';
  if (action.action === 'TYPE') {
    // TYPE into password field is high risk
    if ((action.target || '').toLowerCase().includes('password')) return 'high';
    return 'low';
  }
  if (action.action === 'CLICK') {
    const target = (action.target || '').toLowerCase();
    if (HIGH_KEYWORDS.test(target)) return 'high';
    if (MEDIUM_KEYWORDS.test(target)) return 'medium';
    // Fallback: treat submit buttons as high-risk final actions
    if (target.includes('submit')) return 'high';
    return 'low';
  }
  return 'low';
}
