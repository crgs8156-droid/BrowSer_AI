// M7 — session-scoped navigation policy state.
//
// The action bridge validates every action against an `ActionPolicy`; the NAVIGATE
// allowlist is DERIVED per step by the agent loop (explicit option, else the scanned
// page's own origin — "navigation may stay on the site the user is on") and stored
// here so a bridge built earlier can validate against the CURRENT allowlist without
// sharing object references. Session-scoped, in-memory, value-free (origins only).

let navigationAllowlist: string[] = [];

export function setNavigationAllowlist(list: readonly string[]): void {
  navigationAllowlist = [...list];
}

export function getNavigationAllowlist(): readonly string[] {
  return navigationAllowlist;
}

/** Parse an https origin from a URL; null on malformed/non-https (fail closed). */
export function originOfUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Part C — allowlist membership (origin-only, fail closed).
 * Matches the bridge's hostname semantics: exact host or true subdomain with
 * port equality. Malformed URLs or entries match nothing.
 */
export function isOriginAllowlisted(url: string, allowlist: readonly string[]): boolean {
  let request: URL;
  try {
    request = new URL(url);
  } catch {
    return false;
  }
  if (request.protocol !== 'https:') return false;
  const requestHost = request.hostname.toLowerCase().replace(/\.+$/, '');
  for (const entry of allowlist) {
    let allowed: URL;
    try {
      allowed = new URL(entry);
    } catch {
      continue;
    }
    if (allowed.protocol !== 'https:') continue;
    const allowedHost = allowed.hostname.toLowerCase().replace(/\.+$/, '');
    const hostMatch =
      requestHost === allowedHost || requestHost.endsWith(`.${allowedHost}`);
    const defaultPort = (u: URL) => (u.protocol === 'https:' ? '443' : u.port);
    const requestPort = request.port || defaultPort(request);
    const allowedPort = allowed.port || defaultPort(allowed);
    if (hostMatch && requestPort === allowedPort) return true;
  }
  return false;
}
