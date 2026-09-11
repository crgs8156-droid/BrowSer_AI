// Error classifier — maps raw codes/messages to user-facing categories.

export type ErrorCategory =
  | 'network'
  | 'llm_timeout'
  | 'llm_parse'
  | 'firewall_block'
  | 'dom_access'
  | 'model_load'
  | 'permission'
  | 'captcha'
  | 'max_steps'
  | 'vault_empty'
  | 'unknown';

export interface ClassifiedError {
  code: string;
  message: string;
  category: ErrorCategory;
  recoverable: boolean;
  debugHint: string;
}

const MAP: Record<string, { category: ErrorCategory; recoverable: boolean; message: string; hint: string }> = {
  // network
  'planner request failed': { category: 'network', recoverable: true, message: 'Backend unreachable', hint: 'Start backend: cd backend/fastapi && uvicorn app.main:app --port 8000' },
  'ECONNREFUSED': { category: 'network', recoverable: true, message: 'Backend unreachable', hint: 'Check backend is running on localhost:8000' },
  'llm_unavailable': { category: 'network', recoverable: true, message: 'Backend unreachable', hint: 'Backend returned 502 llm_unavailable — check provider and network' },
  'FETCH_FAILED': { category: 'network', recoverable: true, message: 'Backend unreachable', hint: 'Network fetch failed — check backend' },
  // llm
  'llm_timeout': { category: 'llm_timeout', recoverable: true, message: 'AI planner timed out', hint: 'LLM took too long — try again or switch to Offline mode' },
  'LLM_TIMEOUT': { category: 'llm_timeout', recoverable: true, message: 'AI planner timed out', hint: 'Try again or switch to Offline' },
  'PLANNER_FAILED': { category: 'network', recoverable: true, message: 'AI planner failed', hint: 'Planner request failed — check backend logs' },
  // parse
  'llm_parse': { category: 'llm_parse', recoverable: true, message: 'AI returned unexpected response', hint: 'Check OLLAMA_MODEL supports JSON output' },
  'JSON_PARSE': { category: 'llm_parse', recoverable: true, message: 'AI returned unexpected response', hint: 'LLM returned non-JSON' },
  // firewall
  // firewall — one entry per distinct verdict so structural blocks are never
  // misreported as PII detections (fail-closed either way; the copy differs).
  'FIREWALL_BLOCKED': { category: 'firewall_block', recoverable: false, message: 'Privacy firewall blocked this request', hint: 'Raw PII detected — request not sent (fail-closed)' },
  'FIREWALL_PII_DETECTED': { category: 'firewall_block', recoverable: false, message: 'Privacy firewall blocked this request', hint: 'Raw PII detected in payload — request not sent (fail-closed)' },
  'FIREWALL_MALFORMED': { category: 'firewall_block', recoverable: false, message: 'Privacy firewall blocked this request', hint: 'Malformed payload shape — request not sent (fail-closed; not a content hit)' },
  'FIREWALL_BAD_ALIAS': { category: 'firewall_block', recoverable: false, message: 'Privacy firewall blocked this request', hint: 'Invalid alias grammar — request not sent (fail-closed)' },
  'FIREWALL_BAD_ACTIONS': { category: 'firewall_block', recoverable: false, message: 'Privacy firewall blocked this request', hint: 'Invalid action vocabulary — request not sent (fail-closed)' },
  'FIREWALL_UNEXPECTED_FIELD': { category: 'firewall_block', recoverable: false, message: 'Privacy firewall blocked this request', hint: 'Unexpected payload field — request not sent (fail-closed)' },
  'firewall_block': { category: 'firewall_block', recoverable: false, message: 'Privacy firewall blocked this request', hint: 'PII detected in payload' },
  'PII_DETECTED': { category: 'firewall_block', recoverable: false, message: 'Privacy firewall blocked this request', hint: 'Raw PII in request' },
  // dom
  'SCAN_FAILED': { category: 'dom_access', recoverable: false, message: 'Cannot access this page', hint: 'Chrome extensions cannot scan chrome:// pages' },
  'PAGE_UNREACHABLE': { category: 'dom_access', recoverable: false, message: 'Cannot access this page', hint: 'Try on regular website' },
  // permission
  'permission': { category: 'permission', recoverable: false, message: 'Permission required', hint: 'Reload extension or grant activeTab' },
  'PERMISSION_DENIED': { category: 'permission', recoverable: false, message: 'Permission required', hint: 'Chrome permission denied' },
  // model
  'model_load': { category: 'model_load', recoverable: true, message: 'Vision model unavailable', hint: 'Icon detection model failed — using text analysis only' },
  'VISION_MODEL_UNAVAILABLE': { category: 'model_load', recoverable: true, message: 'Vision model unavailable', hint: 'Model failed to load' },
  // captcha
  'CAPTCHA_DETECTED': { category: 'captcha', recoverable: false, message: 'CAPTCHA detected', hint: 'Solve CAPTCHA manually then Resume' },
  'paused_captcha': { category: 'captcha', recoverable: false, message: 'CAPTCHA detected', hint: 'Solve then Resume' },
  // max steps
  'MAX_STEPS_REACHED': { category: 'max_steps', recoverable: false, message: 'Task reached step limit (10/10)', hint: 'Task too complex — retry with simpler task' },
  'NO_PROGRESS': { category: 'max_steps', recoverable: false, message: 'Task reached step limit', hint: 'No progress — step limit' },
  'max_steps': { category: 'max_steps', recoverable: false, message: 'Task reached step limit (10/10)', hint: 'Step budget reached' },
  // vault
  'ALIAS_UNKNOWN': { category: 'vault_empty', recoverable: false, message: 'No aliases in vault', hint: 'Vault empty — no PII to fill' },
  // special
  'NAVIGATE_NEEDS_APPROVAL': { category: 'permission', recoverable: false, message: 'Navigation needs approval', hint: 'Allow navigation to continue' },
};

export function classifyError(input: string, httpStatus?: number): ClassifiedError {
  const key = (input || '').trim();
  const lower = key.toLowerCase();
  // HTTP status based
  if (httpStatus === 422) return { code: key, message: 'Privacy firewall blocked this request', category: 'firewall_block', recoverable: false, debugHint: 'HTTP 422 — PII detected, not sent' };
  if (httpStatus === 502 && lower.includes('timeout')) return { code: key, message: 'AI planner timed out', category: 'llm_timeout', recoverable: true, debugHint: 'HTTP 502 llm_timeout' };
  if (httpStatus === 502) return { code: key, message: 'Backend unreachable', category: 'network', recoverable: true, debugHint: 'HTTP 502 llm_unavailable' };
  // Direct map
  if (MAP[key]) {
    const m = MAP[key]!;
    return { code: key, message: m.message, category: m.category, recoverable: m.recoverable, debugHint: m.hint };
  }
  // Fuzzy
  if (lower.includes('fetch failed') || lower.includes('econnrefused') || lower.includes('networkerror')) {
    return { code: key, message: 'Backend unreachable', category: 'network', recoverable: true, debugHint: 'Network fetch failed' };
  }
  if (lower.includes('timeout')) return { code: key, message: 'AI planner timed out', category: 'llm_timeout', recoverable: true, debugHint: 'Timeout' };
  if (lower.includes('json') || lower.includes('parse')) return { code: key, message: 'AI returned unexpected response', category: 'llm_parse', recoverable: true, debugHint: 'JSON parse failure' };
  if (lower.includes('firewall') || lower.includes('pii detected')) return { code: key, message: 'Privacy firewall blocked this request', category: 'firewall_block', recoverable: false, debugHint: 'Firewall block' };
  if (lower.includes('permission') || lower.includes('chrome.tabs')) return { code: key, message: 'Permission required', category: 'permission', recoverable: false, debugHint: 'Chrome permission denied' };
  if (lower.includes('vision') || lower.includes('onnx') || lower.includes('model')) return { code: key, message: 'Vision model unavailable', category: 'model_load', recoverable: true, debugHint: 'Model load failed' };
  if (lower.includes('captcha')) return { code: key, message: 'CAPTCHA detected', category: 'captcha', recoverable: false, debugHint: 'CAPTCHA' };
  if (lower.includes('max_steps') || lower.includes('no_progress') || lower.includes('step limit')) return { code: key, message: 'Task reached step limit (10/10)', category: 'max_steps', recoverable: false, debugHint: 'Step limit' };
  if (lower.includes('alias') || lower.includes('vault')) return { code: key, message: 'No aliases in vault', category: 'vault_empty', recoverable: false, debugHint: 'Vault empty' };
  if (lower.includes('scan_failed') || lower.includes('dom') || lower.includes('page_unreachable')) return { code: key, message: 'Cannot access this page', category: 'dom_access', recoverable: false, debugHint: 'DOM access failed' };
  return { code: key || 'unknown', message: key || 'Unknown error', category: 'unknown', recoverable: false, debugHint: 'No hint' };
}

export function classifyFromStatus(status: string, reason?: string): ClassifiedError {
  if (status === 'max_steps') return classifyError(reason ?? 'max_steps');
  if (status === 'firewall_blocked') return classifyError(reason ?? 'FIREWALL_BLOCKED');
  if (status === 'paused_captcha') return classifyError('CAPTCHA_DETECTED');
  if (status === 'blocked' && reason === 'NAVIGATE_NEEDS_APPROVAL') return classifyError('NAVIGATE_NEEDS_APPROVAL');
  if (status === 'error') return classifyError(reason ?? 'unknown');
  return classifyError(reason ?? status);
}
