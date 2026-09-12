// Known-service name → URL map for navigation-only tasks ("open gmail").
//
// The planner never invents URLs: a bare service name resolves to a fixed,
// well-known origin, and the emitted NAVIGATE target still comes from the
// LOCAL session allowlist (see planner.ts). The loop's Part C confirmation
// gate is unchanged — off-allowlist navigation still needs explicit user
// approval. Pure functions, tested in tests/unit/agent/services.test.ts.

export const KNOWN_SERVICES: Record<string, string> = {
  gmail: 'https://mail.google.com',
  google: 'https://www.google.com',
  youtube: 'https://www.youtube.com',
  github: 'https://github.com',
  linkedin: 'https://www.linkedin.com',
  twitter: 'https://www.x.com',
  instagram: 'https://www.instagram.com',
  facebook: 'https://www.facebook.com',
  amazon: 'https://www.amazon.in',
  flipkart: 'https://www.flipkart.com',
  irctc: 'https://www.irctc.co.in',
  digilocker: 'https://www.digilocker.gov.in',
  umang: 'https://web.umang.gov.in',
  incometax: 'https://www.incometax.gov.in',
  sbi: 'https://www.onlinesbi.sbi',
  ilovepdf: 'https://www.ilovepdf.com',
  notion: 'https://www.notion.so',
  drive: 'https://drive.google.com',
  docs: 'https://docs.google.com',
  sheets: 'https://sheets.google.com',
};

/**
 * Resolve the first known service name mentioned in the task to its URL.
 * Substring match on the lowercased objective; first map hit wins. Returns
 * null when the task names no known service (form tasks, unknown sites).
 */
export function extractServiceUrl(taskObjective: string): string | null {
  const lower = (taskObjective ?? '').toLowerCase();
  for (const [name, url] of Object.entries(KNOWN_SERVICES)) {
    if (lower.includes(name)) return url;
  }
  return null;
}

const NAVIGATION_VERBS = [
  'open',
  'go to',
  'navigate to',
  'visit',
  'take me to',
  'load',
  'search for',
];

/** Task verbs that imply filling, submitting, or handling credentials/payment. */
const CREDENTIAL_VERBS = /\blogin\b|\bpassword\b|\bcredential\b|\bsign.?in\b|\bauth\b/i;
const PAYMENT_VERBS = /\bpay\b|\bcard\b|\bupi\b|\bcheckout\b|\bpurchase\b|\bbuy\b/i;
const FILL_SUBMIT_VERBS = /\bfill\b|\bsubmit\b|\benter\b/i;

/** True when the task handles credentials (login, password, sign-in, auth). */
export function taskInvolvesCredentials(taskObjective: string): boolean {
  return CREDENTIAL_VERBS.test(taskObjective ?? '');
}

/** True when the task handles payment (pay, card, UPI, checkout, purchase). */
export function taskInvolvesPayment(taskObjective: string): boolean {
  return PAYMENT_VERBS.test(taskObjective ?? '');
}

/**
 * True for navigation-only tasks ("open youtube"): starts with a navigation
 * verb and names no fill/submit/credential/payment intent. Navigation tasks
 * never submit page data, so credential-bearing pages are a false-positive
 * BLOCK for them (the values stay aliased; see the policy downgrade).
 */
export function isNavigationOnlyTask(taskObjective: string): boolean {
  const lower = (taskObjective ?? '').toLowerCase().trim();
  const navigates = NAVIGATION_VERBS.some((verb) => lower.startsWith(verb));
  if (!navigates) return false;
  return (
    !taskInvolvesCredentials(taskObjective) &&
    !taskInvolvesPayment(taskObjective) &&
    !FILL_SUBMIT_VERBS.test(taskObjective)
  );
}
