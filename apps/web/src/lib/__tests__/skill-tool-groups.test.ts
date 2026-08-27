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

/** Une ligne du catalogue, telle que le seeder l'écrit. */
const duCatalogue = (slug: string) => ({ slug, isSystem: true });
/** Une ligne écrite par l'utilisateur, qui se trouve porter le même nom. */
const deLUtilisateur = (slug: string) => ({ slug, isSystem: false });

describe('isToolGroupSkill', () => {
  it('range dans Tools les skills dont la valeur EST l’outil déverrouillé', () => {
    // Les familles Office : 24 builtins, un mode d'emploi, aucune posture.
    expect(isToolGroupSkill(duCatalogue('office-editing'))).toBe(true);
    expect(isToolGroupSkill(duCatalogue('spreadsheet-editing'))).toBe(true);
    expect(isToolGroupSkill(duCatalogue('document-editing'))).toBe(true);
    expect(isToolGroupSkill(duCatalogue('presentation-editing'))).toBe(true);
  });

  it('un skill de l’UTILISATEUR au même nom reste gérable dans Skills', () => {
    // Constat de la revue Codex. Le seeder préserve désormais une ligne de
    // l'utilisateur qui occupe un slug du catalogue — elle existe donc pour de
    // bon. Classée sur le seul slug, elle basculait dans Tools : invisible
    // dans Skills, et impossible à renommer pour libérer la place. Protégée de
    // l'écrasement pour devenir inatteignable, ce qui n'est pas mieux.
    expect(
      isToolGroupSkill(deLUtilisateur('office-editing')),
      'le skill de l’utilisateur a été rangé dans Tools : il devient ingérable',
    ).toBe(false);
    expect(isToolGroupSkill(deLUtilisateur('code-task'))).toBe(false);
  });

  it('laisse « code-review » du côté des SKILLS, malgré son builtin', () => {
    // Le constat qui a fait changer la règle. `code-review` gate
    // `review_verdict`, donc l'ancienne déduction le rangeait dans Tools — et
    // sa discipline de relecteur devenait introuvable et non éditable.
    expect(
      isToolGroupSkill(duCatalogue('code-review')),
      'code-review est de nouveau rangé dans Tools : sa discipline redevient invisible',
    ).toBe(false);

    // Et il gate bien un builtin : c'est ce qui le faisait basculer avant.
    const codeReview = systemSkills.find((s) => s.slug === 'code-review');
    expect(codeReview?.requiredBuiltins ?? []).toContain('review_verdict');
  });

  it('« dev » n’a jamais gaté d’outil et reste un skill', () => {
    expect(isToolGroupSkill(duCatalogue('dev'))).toBe(false);
  });

  it('un skill communautaire ou appris n’est jamais un groupe d’outils', () => {
    expect(isToolGroupSkill(deLUtilisateur('kanban'))).toBe(false);
    expect(isToolGroupSkill(deLUtilisateur('un-slug-invente-par-un-agent'))).toBe(false);
  });

  it('la liste vient du CATALOGUE, pas d’une copie locale', () => {
    // Un slug ajouté au catalogue avec `toolGroup: true` doit atterrir dans
    // Tools sans que ce fichier soit modifié (invariant #1).
    const declares = systemSkills.filter((s) => s.toolGroup === true).map((s) => s.slug);
    expect(declares.length).toBeGreaterThan(0);
    for (const slug of declares) {
      expect(
        isToolGroupSkill(duCatalogue(slug)),
        `${slug} est déclaré tool group mais n’y va pas`,
      ).toBe(true);
    }
    // Et aucun skill non déclaré ne s'y retrouve.
    for (const s of systemSkills.filter((x) => x.toolGroup !== true)) {
      expect(isToolGroupSkill(duCatalogue(s.slug)), `${s.slug} y va sans l’avoir déclaré`).toBe(
        false,
      );
    }
  });
});
