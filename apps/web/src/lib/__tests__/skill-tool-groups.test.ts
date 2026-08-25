// skill-tool-groups.test.ts — quels skills l'interface range dans Tools plutôt
// que dans Skills. Pas de base, prédicat pur.
//
// Le classement est DÉCLARÉ par chaque skill du catalogue depuis le 25/08, plus
// déduit de « gate-t-il un builtin ». La déduction rangeait dans Tools des
// skills dont la vraie charge utile est une DISCIPLINE : `code-review` porte
// sept règles sur la façon de juger le travail d'autrui, et le propriétaire ne
// pouvait ni les lire ni les modifier depuis la page Skills.

import { describe, it, expect } from 'vitest';
import { isToolGroupSkill } from '../skill-tool-groups.ts';
import { systemSkills } from '@nodal-agents/catalog';

describe('isToolGroupSkill', () => {
  it('range dans Tools les skills dont la valeur EST l’outil déverrouillé', () => {
    // Les familles Office : 24 builtins, un mode d'emploi, aucune posture.
    expect(isToolGroupSkill({ slug: 'office-editing' })).toBe(true);
    expect(isToolGroupSkill({ slug: 'spreadsheet-editing' })).toBe(true);
    expect(isToolGroupSkill({ slug: 'document-editing' })).toBe(true);
    expect(isToolGroupSkill({ slug: 'presentation-editing' })).toBe(true);
  });

  it('laisse « code-review » du côté des SKILLS, malgré son builtin', () => {
    // Le constat qui a fait changer la règle. `code-review` gate
    // `review_verdict`, donc l'ancienne déduction le rangeait dans Tools — et
    // sa discipline de relecteur devenait introuvable et non éditable.
    expect(
      isToolGroupSkill({ slug: 'code-review' }),
      'code-review est de nouveau rangé dans Tools : sa discipline redevient invisible',
    ).toBe(false);

    // Et il gate bien un builtin : c'est ce qui le faisait basculer avant.
    const codeReview = systemSkills.find((s) => s.slug === 'code-review');
    expect(codeReview?.requiredBuiltins ?? []).toContain('review_verdict');
  });

  it('« dev » n’a jamais gaté d’outil et reste un skill', () => {
    expect(isToolGroupSkill({ slug: 'dev' })).toBe(false);
  });

  it('un skill communautaire ou appris n’est jamais un groupe d’outils', () => {
    expect(isToolGroupSkill({ slug: 'kanban' })).toBe(false);
    expect(isToolGroupSkill({ slug: 'un-slug-invente-par-un-agent' })).toBe(false);
  });

  it('la liste vient du CATALOGUE, pas d’une copie locale', () => {
    // Un slug ajouté au catalogue avec `toolGroup: true` doit atterrir dans
    // Tools sans que ce fichier soit modifié (invariant #1).
    const declares = systemSkills.filter((s) => s.toolGroup === true).map((s) => s.slug);
    expect(declares.length).toBeGreaterThan(0);
    for (const slug of declares) {
      expect(isToolGroupSkill({ slug }), `${slug} est déclaré tool group mais n’y va pas`).toBe(
        true,
      );
    }
    // Et aucun skill non déclaré ne s'y retrouve.
    for (const s of systemSkills.filter((x) => x.toolGroup !== true)) {
      expect(isToolGroupSkill({ slug: s.slug }), `${s.slug} y va sans l’avoir déclaré`).toBe(false);
    }
  });
});
