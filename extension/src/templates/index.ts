// Phase 4 — task templates (SIH 2026 demo shortcuts).
//
// Templates are NOT sensitive: natural-language instructions referencing alias
// categories ("my email"), never values. Stored in `chrome.storage.local`
// (survives restarts by design — no PII to protect). Pure list helpers are
// unit-tested; storage wrappers fail closed to defaults.

export interface TaskTemplate {
  id: string;
  name: string;
  icon: string;
  /** Natural language instruction — alias categories only, never values. */
  instruction: string;
  /** Shown in UI. */
  description: string;
}

export const TEMPLATE_STORAGE_KEY = 'taskTemplates';

export const DEFAULT_TEMPLATES: TaskTemplate[] = [
  {
    id: 'login',
    name: 'Login',
    icon: '\u{1F510}',
    instruction: 'Fill the login form with my email and password and submit',
    description: 'Auto-fill and submit any login form',
  },
  {
    id: 'contact-form',
    name: 'Contact',
    icon: '\u{1F4DD}',
    instruction: 'Fill this contact form with my name, email, and phone number and submit',
    description: 'Fill name, email, phone and submit',
  },
  {
    id: 'profile-update',
    name: 'Profile',
    icon: '\u{1F464}',
    instruction: 'Update my profile with my saved personal details',
    description: 'Fill profile fields with saved info',
  },
  {
    id: 'checkout',
    name: 'Checkout',
    icon: '\u{1F6D2}',
    instruction: 'Fill the checkout form with my address and payment details',
    description: 'Autofill shipping and payment at checkout',
  },
  {
    id: 'govt-form',
    name: 'Govt',
    icon: '\u{1F3DB}\uFE0F',
    instruction: 'Fill this government form with my Aadhaar, name, address, and date of birth',
    description: 'Fill DigiLocker/UMANG/government portals',
  },
];

function isValidTemplate(t: unknown): t is TaskTemplate {
  if (typeof t !== 'object' || t === null) return false;
  const r = t as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' && (r['id'] as string).length > 0 &&
    typeof r['name'] === 'string' &&
    typeof r['icon'] === 'string' &&
    typeof r['instruction'] === 'string' && (r['instruction'] as string).trim().length > 0 &&
    typeof r['description'] === 'string'
  );
}

/** Fresh copy of the built-in defaults. */
export function getDefaultTemplates(): TaskTemplate[] {
  return DEFAULT_TEMPLATES.map((t) => ({ ...t }));
}

/** Instruction text for a template id (wired to the panel textarea). */
export function instructionForTemplate(list: TaskTemplate[], id: string): string | null {
  const found = list.find((t) => t.id === id);
  return found ? found.instruction : null;
}

/** Pure add (custom ids are namespaced to avoid collisions with defaults). */
export function addTemplate(list: TaskTemplate[], draft: Omit<TaskTemplate, 'id'> & { id?: string }): TaskTemplate[] {
  const id = draft.id && draft.id.trim().length > 0 ? draft.id.trim() : `custom-${Date.now()}`;
  const entry: TaskTemplate = { ...draft, id };
  if (!isValidTemplate(entry)) return list.slice();
  if (list.some((t) => t.id === id)) return list.slice();
  return [...list, entry];
}

/** Pure delete (defaults can be hidden by the user too — reload restores). */
export function deleteTemplate(list: TaskTemplate[], id: string): TaskTemplate[] {
  return list.filter((t) => t.id !== id);
}

/** Load user templates; defaults when storage is unavailable or malformed. */
export async function loadTemplates(): Promise<TaskTemplate[]> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const data = await chrome.storage.local.get(TEMPLATE_STORAGE_KEY);
      const stored = (data as Record<string, unknown>)[TEMPLATE_STORAGE_KEY];
      if (Array.isArray(stored) && stored.every(isValidTemplate)) {
        return (stored as TaskTemplate[]).map((t) => ({ ...t }));
      }
    }
  } catch {
    // ignore - fall back to defaults
  }
  return getDefaultTemplates();
}

/** Persist user templates (best-effort). */
export async function saveTemplates(list: TaskTemplate[]): Promise<void> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [TEMPLATE_STORAGE_KEY]: list });
    }
  } catch {
    // ignore - persistence is best-effort
  }
}
