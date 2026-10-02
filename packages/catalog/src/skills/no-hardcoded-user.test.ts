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

  // 02/10/2026 (étude Hermes) : « Do not delegate it » était une règle propre à
  // l'impression, contre un manuel d'équipe qui poussait à déléguer. Le manuel
  // dit maintenant, pour tout travail, quand passer la main (team-block.ts) :
  // le skill ne dit plus rien de la délégation, et garde sa promesse.
  it('says nothing of delegation: the team manual decides that for every kind of work', () => {
    expect(skill?.description).toContain(
      'The only valid answer to a print request is a print preview they can approve',
    );
    expect(skill?.description).toContain('with no questions on the way');
    expect(`${skill?.description}\n${skill?.content}`).not.toMatch(/delegat/i);
  });

  it('names no user, e-mail, printer model or server', () => {
    const text = `${skill?.description}\n${skill?.content}`;
    expect(text).not.toMatch(/quentin/i);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(text).not.toMatch(/\b(hp|smart[- ]?tank|deskjet|laserjet|epson|canon|brother)\b/i);
    expect(text).not.toMatch(/https?:\/\/(?!URL)/);
  });
});
