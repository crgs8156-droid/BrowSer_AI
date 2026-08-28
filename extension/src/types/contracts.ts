// Shared data contracts (blueprint §14). Types only — no runtime logic.
// See docs/interface-contracts.md for the accompanying design notes.

export type SensitiveCategory =
  'EMAIL' | 'PHONE' | 'NAME' | 'ADDRESS' | 'PASSWORD' | 'OTP' | 'PAYMENT' | 'ID' | 'CUSTOM';

export type PerceptionSource = 'DOM' | 'OCR' | 'VISION' | 'FUSED';

export interface SensitiveEntity {
  id: string;
  category: SensitiveCategory;
  source: PerceptionSource;
  /** Local-only for protected entities; never serialized into a remote payload. */
  text?: string;
  bbox?: [number, number, number, number]; // [x, y, width, height]
  screenshotId?: string; // ID of the screenshot where the entity was detected
  confidence: number;
  reasons: string[];
  elementId?: string;
}

export interface AliasRecord {
  /** e.g. USER_EMAIL_1 */
  alias: string;
  category: SensitiveCategory;
  sessionId: string;
  createdAt: number;
  // actualValue MUST remain local (stored in the vault, never serialized remotely).
}

export type AgentAction =
  | { action: 'CLICK'; target: string }
  | { action: 'TYPE'; target: string; value: string }
  | { action: 'SELECT'; target: string; value: string }
  | { action: 'SCROLL'; amount: number }
  | { action: 'NAVIGATE'; url: string };

export type AgentActionKind = AgentAction['action'];

export type PrivacyEventType =
  'DETECTED' | 'SANITIZED' | 'BLOCKED' | 'ALIAS_RESOLVED' | 'TASK_RESULT';

export interface PrivacyEvent {
  type: PrivacyEventType;
  entityCategory?: SensitiveCategory;
  alias?: string;
  timestamp: number;
  // never store the raw protected value
}

/**
 * Sanitized request that may cross the remote boundary.
 * See docs/threat-model.md §5 (allowlist) and §6 (denylist).
 */
export interface RemoteAgentRequest {
  taskObjective: string;
  sanitizedPageStructure: unknown[];
  sanitizedVisibleText: string;
  aliases: { alias: string; category: SensitiveCategory }[];
  availableActions: AgentActionKind[];
  policy: { privacyMode: string; navigationAllowlist: string[] };
}
