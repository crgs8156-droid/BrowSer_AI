// Browser-restriction detection for M3.
//
// This is a CAPABILITY check, not a content policy. The hosts/schemes below are
// places where the browser itself forbids extension scripting and tab capture,
// so no amount of permission grants would make visual perception work there.
// It is deliberately NOT a list of "sensitive websites" — M3 never varies its
// behaviour based on which site the user is visiting (see decision.ts).
//
// We also FAIL CLOSED: anything we cannot parse or positively identify as an
// operable page is treated as restricted rather than attempted.

/** Exact reason code required by the M3 result contract. */
export const BROWSER_RESTRICTION_REASON = 'browser_security_restriction';

/**
 * The extension declares `host_permissions` for http/https only, so every other
 * scheme (chrome:, about:, devtools:, file:, moz-extension:, view-source:, …) is
 * out of reach by construction.
 */
const OPERABLE_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

/** Extension-gallery hosts. Browsers block extension access to these outright. */
const BLOCKED_HOSTS: ReadonlySet<string> = new Set([
  'chromewebstore.google.com',
  'addons.mozilla.org',
  'microsoftedge.microsoft.com',
]);

/** Legacy Chrome Web Store lives under a path prefix on a general-purpose host. */
const PATH_BLOCKED_HOSTS: ReadonlyMap<string, string> = new Map([
  ['chrome.google.com', '/webstore'],
]);

/**
 * True when the browser prevents extensions from perceiving this page at all.
 * Unparseable or empty input is treated as restricted (fail closed).
 */
export function isRestrictedUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return true;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }

  if (!OPERABLE_SCHEMES.has(parsed.protocol)) return true;

  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return true;

  const blockedPrefix = PATH_BLOCKED_HOSTS.get(host);
  if (blockedPrefix !== undefined && parsed.pathname.startsWith(blockedPrefix)) return true;

  return false;
}
