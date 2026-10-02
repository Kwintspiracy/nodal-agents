// no-hardcoded-user.test.ts — Finding I-5: a system skill must never hardcode
// a specific user's name (invariant #6, "no per-user hardcoded values"). This
// scans every shipped system skill's content for the operator's own name so
// the regression can't silently reappear in a future skill edit.

import { describe, it, expect } from 'vitest';
import { systemSkills } from '../index';

describe('system skill catalog — no hardcoded per-user values (I-5)', () => {
  it('no skill content mentions "Quentin"', () => {
    for (const skill of systemSkills) {
      expect(skill.content, `${skill.slug} must not reference a specific user by name`).not.toMatch(
        /quentin/i,
      );
    }
  });
});

describe('print-request skill', () => {
  const skill = systemSkills.find((s) => s.slug === 'print-request');

  it('is registered in the catalog as a capability skill with no builtin requirement', () => {
    expect(skill).toBeDefined();
    expect(skill?.name).toBe('Print requests');
    expect(skill?.requiredBuiltins).toEqual([]);
    expect(skill?.kind ?? 'capability').toBe('capability');
    expect(skill?.content).toContain('the only valid answer is a print preview');
  });

  it('lays out inside the printable area the print tool reports, full-bleed only on request', () => {
    expect(skill?.content).toContain(
      "Before laying out, read what the print tool reports about the paper loaded and the printable area of the chosen printer, and keep every page's content inside it: page margins at least the printable area (when the tool states none, keep its default margins). Full-bleed only when the person asks for it.",
    );
  });

  it('tells the model to check the report, fix and replace the pending request', () => {
    const c = skill?.content ?? '';
    expect(c).toContain('EXACTLY as the source or the reading tool gave it');
    expect(c).toContain('Never add, remove or change a parameter');
    expect(c).toContain('printed in colour when the print tool allows it');
    expect(c).toContain('exactly the number of pages asked');
    expect(c).toContain('REPLACING the pending request');
    expect(c).toContain('at most 2 corrections');
    expect(c).not.toContain('Then stop');
    expect(c).not.toContain('natural length');
    expect(skill?.description).toContain('Check the print tool report and fix the page');
  });

  it('names no user, e-mail, printer model or server', () => {
    const text = `${skill?.description}\n${skill?.content}`;
    expect(text).not.toMatch(/quentin/i);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(text).not.toMatch(/\b(hp|smart[- ]?tank|deskjet|laserjet|epson|canon|brother)\b/i);
    expect(text).not.toMatch(/https?:\/\/(?!URL)/);
  });
});
