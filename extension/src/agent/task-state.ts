// Safe session task state persistence (chrome.storage.session, session-only).
// Stores only safe fields: taskId, objective, step index, alias-level step records.
// Never raw PII, vault values, OCR, screenshots.

export interface SafeTaskState {
  taskId: string;
  taskObjective: string;
  currentStep: number;
  steps: Array<{ index: number; action: string | null; outcome: string; ok: boolean }>;
  status: 'running' | 'completed' | 'stopped';
  updatedAt: number;
}

const STORAGE_KEY = 'privagent_active_task';

async function getStorage(): Promise<chrome.storage.StorageArea | null> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.session) return chrome.storage.session;
    if (typeof chrome !== 'undefined' && chrome.storage?.local) return chrome.storage.local;
  } catch {
    // ignore - storage unavailable in this context
  }
  return null;
}

export async function saveTaskState(state: SafeTaskState): Promise<void> {
  const area = await getStorage();
  if (!area) return;
  try {
    await area.set({ [STORAGE_KEY]: state });
  } catch {
    // ignore - session-only persistence is best-effort
  }
}

export async function loadTaskState(): Promise<SafeTaskState | null> {
  const area = await getStorage();
  if (!area) return null;
  try {
    const data = await area.get(STORAGE_KEY);
    const val = (data as Record<string, unknown>)[STORAGE_KEY] as SafeTaskState | undefined;
    if (val && typeof val.taskObjective === 'string' && Array.isArray(val.steps)) return val;
  } catch {
    // ignore - corrupted or unavailable state reads as absent
  }
  return null;
}

export async function clearTaskState(): Promise<void> {
  const area = await getStorage();
  if (!area) return;
  try {
    await area.remove(STORAGE_KEY);
  } catch {
    // ignore - clearing is best-effort
  }
}
