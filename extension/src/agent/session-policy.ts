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
