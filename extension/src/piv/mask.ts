// PIV value masking — strict per-category rules.
//
// NEVER shows a full value by default. Uses • bullets, never asterisks.
// PIV-local: existing reveal.ts / ScanDetails masks are untouched.

import type { PIVCategory } from './store';

export function maskPivValue(value: string, category: PIVCategory, label: string): string {
  if (!value) return '••••••••';
  // Secrets are never shown, regardless of category (PIN lives under contact).
  if (/pass|pin|otp|code|cvv|expiry|secret/i.test(label)) return '••••••••';
  switch (category) {
    case 'contact': {
      // Email vs phone distinguished by shape, not by label.
      const at = value.indexOf('@');
      if (at > 0) {
        const local = value.slice(0, Math.min(4, at));
        const domain = value.slice(at);
        const tldIdx = domain.lastIndexOf('.');
        const tld = tldIdx > 0 ? domain.slice(tldIdx) : '';
        return `${local}@•••${tld}`;
      }
      const digits = value.replace(/\D/g, '');
      const core = digits.slice(-10);
      if (core.length === 10) {
        const cc = digits.length > 10 ? `+${digits.slice(0, digits.length - 10)} ` : '';
        return `${cc}${core.slice(0, 2)}•••••${core.slice(-3)}`;
      }
      if (/address/i.test(label) && value.includes(',')) {
        const parts = value.split(',');
        const head = (parts[0] ?? '').trim();
        const tail = (parts[parts.length - 1] ?? '').trim();
        if (head.length > 0 && tail.length > 0 && head !== tail) {
          return `${head}, ••••••, ${tail}`;
        }
      }
      if (value.length <= 4) return '••••';
      return `${value.slice(0, 2)}••••${value.slice(-2)}`;
    }
    case 'identity': {
      const upper = label.toUpperCase();
      const digits = value.replace(/\D/g, '');
      if (upper.includes('PAN') && value.length >= 10) {
        return `${value.slice(0, 2)}•••••••${value.slice(-1)}`;
      }
      if (digits.length >= 12) {
        return `${digits.slice(0, 4)} •••• •••• ${digits.slice(-4)}`;
      }
      if (value.length <= 4) return '••••••••';
      return `${value.slice(0, 2)}••••${value.slice(-2)}`;
    }
    case 'financial': {
      const upper = label.toUpperCase();
      if (upper.includes('UPI') || value.includes('@')) {
        const at = value.indexOf('@');
        if (at > 0) return `${value.slice(0, at)}@•••`;
      }
      const digits = value.replace(/\D/g, '');
      if (digits.length >= 4 && (upper.includes('CARD') || upper.includes('ACCOUNT'))) {
        return `•••• •••• •••• ${digits.slice(-4)}`;
      }
      return '••••••••';
    }
    case 'personal': {
      if (/pass|pin|otp|code/i.test(label)) return '••••••••';
      const first = value.split(/\s+/)[0] ?? value;
      return `${first} •••`;
    }
    case 'professional': {
      if (value.length <= 4) return '••••';
      return `${value.slice(0, 2)}••••${value.slice(-2)}`;
    }
    case 'custom':
    default: {
      if (/pass|pin|otp|code|secret|key|token/i.test(label)) return '••••••••';
      if (value.length <= 4) return '••••';
      return `${value.slice(0, 2)}•••••${value.slice(-2)}`;
    }
  }
}
