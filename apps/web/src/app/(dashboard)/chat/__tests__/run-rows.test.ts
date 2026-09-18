// run-rows.test.ts — les lignes du dossier MCP (18/09/2026).
//
// Ce qu'elles promettent : un run lancé de dehors se lit comme une ligne de
// boîte de réception — un titre, une heure, un signe — et elle ouvre le RUN,
// pas un fil qui n'existe pas.
//
// Les assertions portent sur les lignes rendues, jamais sur des appels comptés.
//
// Mutation vérifiée : `href` ramené à `/chat/<id>` → « ouvre la page du run »
// rougit ; `rootJobId` ignoré dans l'attribution → « la question d'un délégué
// remonte au run » rougit ; `plainText` retiré du titre → « aplatit le
// markdown » rougit.

import { describe, it, expect } from 'vitest';
import { runRows, runTitle, runningCount } from '../run-rows.ts';
import type { ExternalRunRow } from '@/lib/conversation-actions.ts';

const MAINTENANT = new Date('2026-09-18T14:30:00');

function run(over: Partial<ExternalRunRow> = {}): ExternalRunRow {
  return {
    id: 'run-1',
    task: 'Publier la note de version',
    status: 'completed',
    createdAt: new Date('2026-09-18T09:05:00'),
    ...over,
  };
}

describe('la ligne d’un run venu de dehors @cap:parler-par-canal-externe/moteur', () => {
  it('ouvre la page du RUN, et porte la tâche comme titre', () => {
    const [ligne] = runRows({ runs: [run({ id: 'abc', task: 'Ranger le dépôt' })] });
    expect(ligne?.href).toBe('/jobs/abc');
    expect(ligne?.chatName).toBe('Ranger le dépôt');
    // Aucun agent : c'est le titre qui distingue un run d'un autre.
    expect(ligne?.agent).toBeNull();
    // Aucun aperçu : un run n'a pas de dernier mot, il a un résultat.
    expect(ligne?.preview).toBeNull();
  });

  it('garde l’ordre reçu — le plus récent d’abord, celui de la lecture', () => {
    const rows = runRows({
      runs: [run({ id: 'r2', task: 'le second' }), run({ id: 'r1', task: 'le premier' })],
    });
    expect(rows.map((r) => r.chatName)).toEqual(['le second', 'le premier']);
    expect(rows.map((r) => r.href)).toEqual(['/jobs/r2', '/jobs/r1']);
  });

  it('date la ligne du DÉPART du run', () => {
    const [ligne] = runRows({
      runs: [run({ createdAt: new Date('2026-09-18T09:05:00') })],
      now: MAINTENANT,
    });
    // Le même jour : l'heure, comme toute boîte de réception.
    expect(ligne?.time).toBe('09:05');
  });

  it('n’écrit pas de tiret quand la date manque', () => {
    const [ligne] = runRows({ runs: [run({ createdAt: null })], now: MAINTENANT });
    expect(ligne?.time).toBeNull();
  });

  it('aplatit le markdown d’une tâche et ne garde que sa première ligne', () => {
    expect(runTitle('## **Publier**\n\nle reste du texte')).toBe('Publier');
  });

  it('nomme un run dont la tâche est vide plutôt que de laisser un blanc', () => {
    expect(runTitle('   ')).toBe('Untitled run');
  });
});

describe('ce qu’un run attend, et ce qu’il fait @cap:parler-par-canal-externe/moteur', () => {
  it('fait remonter la question d’un DÉLÉGUÉ sur la ligne de son run de tête', () => {
    // Le cœur du sujet : la demande est portée par un job `internal` que rien
    // ne rattache au run, sauf sa chaîne.
    const [ligne] = runRows({
      runs: [run({ id: 'tete' })],
      waiting: [{ rootJobId: 'tete', kind: 'question' }],
    });
    expect(ligne?.waiting).toBe('question');
  });

  it('montre la QUESTION d’abord quand une approbation attend aussi', () => {
    const [ligne] = runRows({
      runs: [run({ id: 'tete' })],
      waiting: [
        { rootJobId: 'tete', kind: 'approval' },
        { rootJobId: 'tete', kind: 'question' },
      ],
    });
    expect(ligne?.waiting).toBe('question');
  });

  it('ne pose sur aucune ligne une demande dont la chaîne n’a pas pu être remontée', () => {
    const [ligne] = runRows({
      runs: [run({ id: 'tete' })],
      waiting: [{ rootJobId: null, kind: 'question' }],
    });
    expect(ligne?.waiting).toBeNull();
  });

  it('ne pose pas la demande d’un autre run sur cette ligne', () => {
    const rows = runRows({
      runs: [run({ id: 'a' }), run({ id: 'b' })],
      waiting: [{ rootJobId: 'b', kind: 'approval' }],
    });
    expect(rows[0]?.waiting).toBeNull();
    expect(rows[1]?.waiting).toBe('approval');
  });

  it('allume le point vert sur un run qui avance, et sur lui seul', () => {
    const rows = runRows({
      runs: [
        run({ id: 'a', status: 'processing' }),
        run({ id: 'b', status: 'awaiting_delegation' }),
        run({ id: 'c', status: 'completed' }),
        // Arrêté sur une approbation : il n'avance pas, il attend la personne.
        run({ id: 'd', status: 'awaiting_approval' }),
      ],
    });
    expect(rows.map((r) => r.running)).toEqual([true, true, false, false]);
    expect(runningCount([run({ status: 'processing' }), run({ status: 'failed' })])).toBe(1);
  });

  it('dit qu’un run arrêté sur une approbation attend, même sans demande lisible', () => {
    // Le statut le dit lui-même. Sans cela, un run bloqué s'afficherait éteint,
    // exactement comme un run terminé.
    const [ligne] = runRows({ runs: [run({ status: 'awaiting_approval' })] });
    expect(ligne?.waiting).toBe('approval');
    expect(ligne?.running).toBe(false);
  });
});
