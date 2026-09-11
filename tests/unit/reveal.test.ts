import { describe, expect, it } from 'vitest';
import { maskValue, toRevealRows } from '../../extension/src/sidepanel/reveal';

describe('reveal masking (masked default, click-to-unmask)', () => {
  it('masks emails as u\u2022\u2022\u2022@\u2022\u2022\u2022', () => {
    expect(maskValue('user@example.test')).toBe('u\u2022\u2022\u2022@\u2022\u2022\u2022');
    expect(maskValue('a@b')).toBe('a\u2022\u2022\u2022@\u2022\u2022\u2022');
  });
  it('masks generic values first+\u2022\u2022\u2022+last', () => {
    expect(maskValue('555-123-4567')).toBe('5\u2022\u2022\u20227');
    expect(maskValue('ab')).toBe('\u2022\u2022\u2022');
  });
  it('toRevealRows preserves value but exposes masked default', () => {
    const rows = toRevealRows([{ alias: 'USER_EMAIL_1', category: 'EMAIL', value: 'user@example.test' }]);
    expect(rows[0]!.masked).toBe('u\u2022\u2022\u2022@\u2022\u2022\u2022');
    expect(rows[0]!.value).toBe('user@example.test');
  });
});
