// M6/M7 seam — privacy firewall public surface.
//
// `createPrivacyFirewall` is the single outbound boundary factory (CONTRIBUTING.md §5
// Rule 6). The implementation lives in `./inspect` so this barrel stays the stable
// import point and the pure logic stays testable in isolation.

export type { FirewallVerdict, PrivacyFirewall } from './inspect';
export { createPrivacyFirewall } from './inspect';
