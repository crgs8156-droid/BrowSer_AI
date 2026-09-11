import { describe, expect, it } from 'vitest';
import {
  addTemplate,
  DEFAULT_TEMPLATES,
  deleteTemplate,
  getDefaultTemplates,
  instructionForTemplate,
  loadTemplates,
} from '../../extension/src/templates';

const CANARY_EMAIL = 'CANARY_EMAIL_001@example.test';
const CANARY_PHONE = '555-123-4567';

describe('task templates (Phase 4)', () => {
  it('ships five defaults with instructions and descriptions', () => {
    expect(DEFAULT_TEMPLATES.map((t) => t.id)).toEqual([
      'login',
      'contact-form',
      'profile-update',
      'checkout',
      'govt-form',
    ]);
    for (const t of getDefaultTemplates()) {
      expect(t.instruction.trim().length).toBeGreaterThan(0);
      expect(t.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('contains no raw values (canary check)', () => {
    const json = JSON.stringify(DEFAULT_TEMPLATES);
    expect(json).not.toContain(CANARY_EMAIL);
    expect(json).not.toContain(CANARY_PHONE);
    expect(json).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });

  it('resolves instructions for chips (click fills textarea)', () => {
    expect(instructionForTemplate(getDefaultTemplates(), 'login')).toContain('login form');
    expect(instructionForTemplate(getDefaultTemplates(), 'nope')).toBeNull();
  });

  it('adds and deletes custom templates (pure)', () => {
    const added = addTemplate(getDefaultTemplates(), {
      name: 'Custom',
      icon: '+',
      instruction: 'Do my custom thing',
      description: 'Custom template',
    });
    expect(added).toHaveLength(6);
    const id = added[5]!.id;
    expect(deleteTemplate(added, id)).toHaveLength(5);
    // invalid drafts and duplicates are rejected
    expect(addTemplate(getDefaultTemplates(), { name: '', icon: '', instruction: '  ', description: '' })).toHaveLength(5);
  });

  it('loads defaults when storage is unavailable (test env has no chrome)', async () => {
    const loaded = await loadTemplates();
    expect(loaded.map((t) => t.id)).toEqual(DEFAULT_TEMPLATES.map((t) => t.id));
  });
});
