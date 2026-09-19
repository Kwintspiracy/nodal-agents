// surface-content.test.ts — ce qu'une skill système dit sur une surface SANS
// outils.
//
// Revue Codex de la dette de la PR #73, constat 1. `surfaces` est un
// interrupteur : déclarer `['job']` retirait du chat TOUT le texte d'une skill,
// y compris ses règles qui ne demandent aucun outil — « ne dis pas que c'est
// fait si tu ne l'as pas vérifié », « dis franchement que tu ne peux pas
// vérifier », « recoupe deux ou trois valeurs quand tu reformates des données ».
// Le chat en devenait PLUS enclin à affirmer sans preuve, ce qui est l'inverse
// du but de la PR.
//
// La skill écrit donc elle-même ce qui en reste vrai (`contentOnChat`), comme
// elle déclare elle-même ses surfaces : c'est la couche catalogue qui sait, pas
// le runtime (invariant #3).

import { describe, it, expect } from 'vitest';
import { chatSurfaceToolNames, skillContentOn, systemSkills } from '../index';
import type { SystemSkill } from '../types';

const skill = (slug: string): SystemSkill => {
  const s = systemSkills.find((x) => x.slug === slug);
  if (!s) throw new Error(`skill introuvable : ${slug}`);
  return s;
};

describe('le texte d’une skill par surface @cap:parler-a-un-agent/moteur', () => {
  it('une skill à outils dit sur le chat ce qui en reste vrai sans outil', () => {
    for (const slug of ['verify-before-done', 'safe-tool-use']) {
      const s = skill(slug);
      const surJob = skillContentOn(s, 'job');
      const surChat = skillContentOn(s, 'chat');

      expect(surJob, `${slug} ne dit rien sur un job`).toBe(s.content.trim());
      expect(surChat, `${slug} ne dit plus rien sur le chat`).not.toBeNull();
      expect(surChat, `${slug} envoie son texte de job sur le chat`).not.toBe(surJob);
      // Plus court, forcément : c'est ce qui reste quand on retire les gestes.
      expect(surChat!.length).toBeLessThan(surJob!.length / 2);
    }
  });

  it('et ce texte-là ne prescrit aucun outil — c’est toute la raison de son existence', () => {
    // Les outils du chat, lus dans l'index de ce paquet — la seule liste qui
    // les nomme, et celle qui type `CHAT_TOOLS` côté runner (issue #211).
    const OUTILS_DU_CHAT = new Set<string>(chatSurfaceToolNames);
    const PAS_DES_OUTILS = new Set(['tool_result', 'snake_case']);
    for (const s of systemSkills) {
      const texte = skillContentOn(s, 'chat');
      if (texte === null) continue;
      const noms = [...texte.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)]
        .map((m) => m[1]!)
        .filter((n) => !OUTILS_DU_CHAT.has(n) && !PAS_DES_OUTILS.has(n));
      expect(noms, `${s.slug} prescrit sur le chat : ${noms.join(', ')}`).toEqual([]);
    }
  });

  it('une skill sans texte de chat n’en fabrique pas un', () => {
    const muette: SystemSkill = {
      slug: 'muette',
      name: 'Muette',
      description: 'x',
      content: '## Muette\n\nAppelle `file_write`.',
      kind: 'baseline',
      surfaces: ['job'],
    };
    expect(skillContentOn(muette, 'chat')).toBeNull();
    expect(skillContentOn(muette, 'job')).toContain('file_write');
  });
});
