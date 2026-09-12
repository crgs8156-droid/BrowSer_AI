import { describe, expect, it } from 'vitest';
import { createPrivacyFirewall } from '../../extension/src/firewall';
import { toSanitizedNodes } from '../../extension/src/agent/loop';
import type { RemoteAgentRequest, SanitizedNode } from '../../extension/src/types/contracts';

function node(partial: Partial<SanitizedNode> & { selector: string }): SanitizedNode {
  return { tag: 'input', filled: false, disabled: false, ...partial };
}

function cleanRequest(partial: Partial<RemoteAgentRequest> = {}): RemoteAgentRequest {
  return {
    taskObjective: 'fill the form and submit',
    sanitizedPageStructure: [node({ selector: '#email', inputType: 'email', label: 'Email' })],
    sanitizedVisibleText: 'Email [SET] — welcome to the demo form',
    aliases: [{ alias: 'USER_EMAIL_1', category: 'EMAIL' }],
    availableActions: ['CLICK', 'TYPE', 'SELECT', 'SCROLL', 'NAVIGATE'],
    policy: { privacyMode: 'strict', navigationAllowlist: [] },
    ...partial,
  };
}

describe('privacy firewall', () => {
  it('allows a well-formed, clean request', async () => {
    const verdict = await createPrivacyFirewall().inspect(cleanRequest());
    expect(verdict).toEqual({ allowed: true, reason: 'OK' });
  });

  it('blocks when sanitized text still contains detectable PII (canary)', async () => {
    const verdict = await createPrivacyFirewall().inspect(
      cleanRequest({ sanitizedVisibleText: 'contact CANARY_EMAIL_001@example.test today' }),
    );
    expect(verdict).toEqual({ allowed: false, reason: 'FIREWALL_PII_DETECTED' });
  });

  it('blocks when a node label contains detectable PII', async () => {
    const verdict = await createPrivacyFirewall().inspect(
      cleanRequest({
        sanitizedPageStructure: [
          node({ selector: '#a', label: 'Owner: 555-123-4567' }),
        ],
      }),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('FIREWALL_PII_DETECTED');
  });

  it('blocks a detectable payment card in any scanned string', async () => {
    const verdict = await createPrivacyFirewall().inspect(
      cleanRequest({
        sanitizedVisibleText: 'card on file 4111 1111 1111 1111',
      }),
    );
    expect(verdict.allowed).toBe(false);
  });

  it('fails closed on unexpected extra fields', async () => {
    const request = cleanRequest() as unknown as Record<string, unknown>;
    request['screenshot'] = 'data:image/png;base64,AAAA';
    const verdict = await createPrivacyFirewall().inspect(request as unknown as RemoteAgentRequest);
    expect(verdict.reason).toBe('FIREWALL_UNEXPECTED_FIELD');
  });

  it('fails closed on malformed input and missing keys', async () => {
    const firewall = createPrivacyFirewall();
    expect((await firewall.inspect(null as unknown as RemoteAgentRequest)).allowed).toBe(false);
    const partial = { taskObjective: 'x' } as unknown as RemoteAgentRequest;
    expect((await firewall.inspect(partial)).reason).toBe('FIREWALL_MALFORMED');
  });

  it('fails closed on bad alias grammar and bad availableActions', async () => {
    const firewall = createPrivacyFirewall();
    const badAlias = cleanRequest({ aliases: [{ alias: 'SECRET_VALUE_7', category: 'EMAIL' }] });
    expect((await firewall.inspect(badAlias)).reason).toBe('FIREWALL_BAD_ALIAS');
    const badActions = cleanRequest({ availableActions: ['EVAL' as never] });
    expect((await firewall.inspect(badActions)).reason).toBe('FIREWALL_BAD_ACTIONS');
  });

  it('accepts an optional provider hint and rejects unknown providers', async () => {
    const firewall = createPrivacyFirewall();
    for (const provider of ['gemini', 'ollama', 'deterministic'] as const) {
      expect((await firewall.inspect(cleanRequest({ provider }))).allowed).toBe(true);
    }
    const bad = cleanRequest({ provider: 'webgpu' as never });
    expect((await firewall.inspect(bad)).reason).toBe('FIREWALL_MALFORMED');
  });

  it('accepts an optional origin-only pageOrigin and rejects full URLs', async () => {
    const firewall = createPrivacyFirewall();
    const withOrigin = cleanRequest({ pageOrigin: 'https://privagent.test' });
    expect((await firewall.inspect(withOrigin)).allowed).toBe(true);

    const fullPath = cleanRequest({ pageOrigin: 'https://privagent.test/form?x=1' });
    expect((await firewall.inspect(fullPath)).reason).toBe('FIREWALL_MALFORMED');
  });

  it('accepts alias strings without false-positiving the PII scan', async () => {
    const verdict = await createPrivacyFirewall().inspect(
      cleanRequest({ sanitizedVisibleText: 'Email USER_EMAIL_1 · Phone USER_PHONE_1' }),
    );
    expect(verdict.allowed).toBe(true);
  });

  it('rejects a chrome:// pageOrigin as malformed, allows undefined + empty arrays', async () => {
    const firewall = createPrivacyFirewall();
    const chromeOrigin = cleanRequest({ pageOrigin: 'chrome://new-tab-page' });
    expect((await firewall.inspect(chromeOrigin)).reason).toBe('FIREWALL_MALFORMED');
    // Navigation-only shape: no nodes, no aliases, blank text, undefined origin.
    const navOnly = cleanRequest({
      pageOrigin: undefined,
      sanitizedPageStructure: [],
      sanitizedVisibleText: '',
      aliases: [],
    });
    expect(await firewall.inspect(navOnly)).toEqual({ allowed: true, reason: 'OK' });
  });

  it('accepts ARIA-hosted nodes (div/span/a) and still rejects unknown tags', async () => {
    const firewall = createPrivacyFirewall();
    const aria = cleanRequest({
      sanitizedPageStructure: [
        node({ selector: '#email', inputType: 'email', label: 'Email' }),
        node({ selector: '#submit', tag: 'div', label: 'Submit' }),
        node({ selector: '#menu', tag: 'span', label: 'Menu' }),
        node({ selector: '#link', tag: 'a', label: 'Next' }),
      ],
    });
    expect(await firewall.inspect(aria)).toEqual({ allowed: true, reason: 'OK' });
    const bad = cleanRequest({
      sanitizedPageStructure: [node({ selector: '#x', tag: 'script' as never })],
    });
    expect((await firewall.inspect(bad)).reason).toBe('FIREWALL_MALFORMED');
  });

  it('accepts sanitizer-normalized exotic nodes end to end', async () => {
    // Raw ARIA hosts (li/img/ul) normalize to div in toSanitizedNodes, so a
    // Google-class page with exotic controls passes the firewall.
    const nodes = toSanitizedNodes([
      { tag: 'li', selector: '#r1', label: 'More', disabled: false },
      { tag: 'img', selector: '#r2', label: 'Photo', disabled: false },
      { tag: 'ul', selector: '#r3', label: 'List', disabled: false },
    ] as unknown as Parameters<typeof toSanitizedNodes>[0]);
    expect(nodes.every((n) => n.tag === 'div')).toBe(true);
    const verdict = await createPrivacyFirewall().inspect(
      cleanRequest({ sanitizedPageStructure: nodes }),
    );
    expect(verdict).toEqual({ allowed: true, reason: 'OK' });
  });
});
