// chat-or-work.test.ts — LES GARDES du plan (P7), une par `it`.
//
// Chaque cas est une phrase du plan : « lire, chercher, noter la mémoire =
// chat », « un fichier, un envoi ailleurs, une commande, le harnais, une
// écriture externe = travail ». Les lignes sont celles que P1 persiste
// vraiment (carte + charge utile validée par le schéma partagé), pas des
// formes inventées pour l'occasion : une charge hors forme serait rejetée par
// `parsePresented` et le test le verrait.

import { describe, it, expect } from 'vitest';
import { classifyProduction, constatedTurnKey, PRODUCED_FILES_MAX } from '../chat-or-work.ts';
import type { ClassifiableRow } from '../chat-or-work.ts';

/** Le fil du dashboard, sauf quand un cas parle d'un canal. */
const dashboard = { channel: 'dashboard', chatId: null };
const telegram = { channel: 'telegram', chatId: '4242' };

const ligne = (over: Partial<ClassifiableRow>): ClassifiableRow => ({
  jobId: 'job-tete',
  turn: 1,
  toolName: 'un_outil',
  card: null,
  presented: null,
  riskLevel: null,
  toolInput: {},
  // Une sortie NON-JSON : c'est ainsi qu'`executeTool` écrit un succès.
  toolOutput: 'ok',
  ...over,
});

/** La sortie qu'`executeTool` écrit quand l'appel n'a PAS abouti. */
const echec = (outcome: 'error' | 'blocked' | 'awaiting_approval') =>
  JSON.stringify({ outcome, error: `${outcome}: rien n'est sorti` });

/**
 * Le tour du job de tête, avec une écriture CONSTATÉE (#197) — ce que le
 * chargeur bâtit depuis `constated_writes`. Par défaut aucun tour n'a écrit :
 * un cas qui veut une commande décisive le DIT.
 */
const aEcrit = new Set([constatedTurnKey('job-tete', 1)]);

/** Une ligne de commande, la carte que `run_command` remplit vraiment. */
const commande = (command: string, over: Partial<ClassifiableRow> = {}): ClassifiableRow =>
  ligne({
    toolName: 'run_command',
    card: 'terminal',
    presented: {
      card: 'terminal',
      command,
      exitCode: 0,
      timedOut: false,
      stdoutTail: 'done',
      stdoutTruncated: false,
      stderrTail: '',
      stderrTruncated: false,
    },
    ...over,
  });

const verdict = (
  rows: ClassifiableRow[],
  conversation: { channel: string; chatId: string | null } = dashboard,
  constatedTurns: ReadonlySet<string> = new Set<string>(),
) => classifyProduction({ conversation, rows, constatedTurns });

describe('classifyProduction — ce qui reste du chat', () => {
  it('« bonjour » : aucune ligne, donc rien à montrer', () => {
    const v = verdict([]);
    expect(v).toEqual({ isWork: false, items: [], uncertain: 0, more: 0, unclassified: 0 });
  });

  it('une recherche web est du chat', () => {
    const v = verdict([
      ligne({
        toolName: 'web_search',
        card: 'search',
        presented: {
          card: 'search',
          query: 'météo demain',
          hits: [{ title: 'Météo', ref: 'https://example.com' }],
          total: 1,
          truncated: false,
        },
      }),
    ]);
    expect(v.isWork).toBe(false);
    expect(v.items).toEqual([]);
  });

  it('noter la mémoire est du chat — même déclaré `write`', () => {
    // save_memory écrit, mais dans la tête de l'agent : rien n'en est sorti.
    // Sa carte est `text`, et c'est la CARTE qui tranche, pas le risque.
    const v = verdict([
      ligne({
        toolName: 'save_memory',
        card: 'text',
        riskLevel: 'write',
        presented: { card: 'text', text: 'Noté : Quentin préfère le français.' },
      }),
    ]);
    expect(v.isWork).toBe(false);
    expect(v.items).toEqual([]);
  });

  it('une carte `checks` seule est du chat — la preuve est faite par le runner', () => {
    const v = verdict([
      ligne({
        toolName: 'verify',
        card: 'checks',
        presented: {
          card: 'checks',
          verdict: 'pass',
          summary: 'Tout passe.',
          items: [{ label: 'unit', ok: true }],
          total: 1,
        },
      }),
    ]);
    expect(v.isWork).toBe(false);
    expect(v.items).toEqual([]);
  });

  it("un sous-agent qui n'a fait que parler ne produit rien", () => {
    const v = verdict([
      ligne({
        toolName: 'assign_task',
        card: 'delegation',
        presented: {
          card: 'delegation',
          to: 'Chercheuse',
          task: 'Résume la page',
          ok: true,
          resultText: 'Voici le résumé.',
          error: null,
          durationMs: 4200,
          costUsd: 0.01,
        },
      }),
      // Ce que le sous-agent a fait, chez lui : lire, rien d'autre.
      ligne({
        jobId: 'job-enfant',
        toolName: 'file_read',
        card: 'read',
        presented: {
          card: 'read',
          path: '/x/notes.md',
          excerpt: 'abc',
          chars: 3,
          truncated: false,
        },
      }),
    ]);
    expect(v.isWork).toBe(false);
    expect(v.items).toEqual([]);
  });
});

describe('classifyProduction — ce qui sort du chat', () => {
  it('un fichier écrit dans un projet est du travail, et l’encart le nomme', () => {
    const v = verdict([
      ligne({
        toolName: 'file_write',
        card: 'files',
        presented: {
          card: 'files',
          files: [{ path: 'src/rapport.md', action: 'created', bytes: 812 }],
          total: 1,
          truncated: false,
        },
      }),
    ]);
    expect(v.isWork).toBe(true);
    expect(v.items).toEqual([{ kind: 'file', label: 'src/rapport.md', path: 'src/rapport.md' }]);
    expect(v.more).toBe(0);
  });

  it('un fichier écrit par un SOUS-AGENT fait l’encart du tour parent', () => {
    const v = verdict([
      ligne({ toolName: 'assign_task', card: 'delegation', presented: null }),
      ligne({
        jobId: 'job-enfant',
        toolName: 'file_write',
        card: 'files',
        presented: {
          card: 'files',
          files: [{ path: 'out/livrable.xlsx', action: 'written' }],
          total: 1,
          truncated: false,
        },
      }),
    ]);
    expect(v.isWork).toBe(true);
    expect(v.items).toEqual([
      { kind: 'file', label: 'out/livrable.xlsx', path: 'out/livrable.xlsx' },
    ]);
  });

  it('un email est du travail : le destinataire n’est pas l’interlocuteur', () => {
    const v = verdict([
      ligne({
        toolName: 'send_email',
        card: 'sent',
        presented: { card: 'sent', channel: 'email', kind: 'message', target: 'paul@example.com' },
      }),
    ]);
    expect(v.isWork).toBe(true);
    expect(v.items).toEqual([{ kind: 'sent', label: 'email to paul@example.com' }]);
  });

  it('répondre sur le canal de la conversation, au même chat, est du chat', () => {
    const v = verdict(
      [
        ligne({
          toolName: 'telegram_send_message',
          card: 'sent',
          presented: { card: 'sent', channel: 'telegram', kind: 'message', target: '4242' },
        }),
      ],
      telegram,
    );
    expect(v.isWork).toBe(false);
    expect(v.items).toEqual([]);
  });

  it('répondre sur le canal de la conversation SANS nommer de cible est du chat aussi', () => {
    // L'outil qui répond au fil courant n'a personne d'autre à nommer : une
    // cible absente vaut l'interlocuteur. Couvert à part parce qu'une mutation
    // de cette branche seule restait verte (revue du 06/09).
    const v = verdict(
      [
        ligne({
          toolName: 'telegram_send_message',
          card: 'sent',
          presented: { card: 'sent', channel: 'telegram', kind: 'message' },
        }),
      ],
      telegram,
    );
    expect(v.isWork).toBe(false);
    expect(v.items).toEqual([]);
  });

  it('le MÊME envoi vers un autre chat est du travail', () => {
    const v = verdict(
      [
        ligne({
          toolName: 'telegram_send_message',
          card: 'sent',
          presented: { card: 'sent', channel: 'telegram', kind: 'message', target: '9999' },
        }),
      ],
      telegram,
    );
    expect(v.isWork).toBe(true);
    expect(v.items).toEqual([{ kind: 'sent', label: 'telegram to 9999' }]);
  });

  it('un fichier envoyé ailleurs porte son nom et sa destination', () => {
    const v = verdict(
      [
        ligne({
          toolName: 'slack_send_file',
          card: 'sent',
          presented: {
            card: 'sent',
            channel: 'slack',
            kind: 'file',
            target: '#ops',
            filename: 'bilan.pdf',
          },
        }),
      ],
      telegram,
    );
    expect(v.isWork).toBe(true);
    expect(v.items).toEqual([{ kind: 'sent', label: 'bilan.pdf to Slack #ops' }]);
  });

  it('une commande dont une écriture a été CONSTATÉE est du travail', () => {
    const v = verdict([commande('pnpm build')], dashboard, aEcrit);
    expect(v.isWork).toBe(true);
    expect(v.items).toEqual([{ kind: 'command', label: 'pnpm build', certain: true }]);
    expect(v.uncertain).toBe(0);
  });

  it('le harnais de code compte une fois, quelles que soient ses lignes internes', () => {
    const v = verdict([
      ligne({ toolName: 'cli:Edit', card: 'files' }),
      ligne({ toolName: 'cli:Read', card: 'read' }),
    ]);
    expect(v.isWork).toBe(true);
    expect(v.items).toEqual([{ kind: 'harness', label: 'Code harness' }]);
  });

  it('le harnais nommé garde son nom', () => {
    const v = verdict([ligne({ toolName: 'cli:codex', card: 'delegation' })]);
    expect(v.items).toEqual([{ kind: 'harness', label: 'Codex' }]);
  });
});

// #197 — LA COMMANDE, TRANCHÉE PAR L'ÉCRITURE CONSTATÉE.
//
// Une carte `terminal` disait « travail » du seul fait d'exister. La carte
// prouve qu'une commande a tourné, jamais qu'elle a écrit : depuis #102 le
// `cwd` d'un shell ne crédite plus rien côté vérification, et #199 range ce qui
// a VRAIMENT été écrit dans `constated_writes`. Le verdict du fil lit ce même
// fait, à la granularité (job, tour).
//
// Mutation vérifiée : `certain` forcé à `true` dans la branche `terminal` →
// « un tour shell qui n'a rien produit n'est pas du travail » rougit.
describe('classifyProduction — la commande, tranchée par l’écriture constatée', () => {
  it('un tour shell qui n’a RIEN produit n’est pas du travail', () => {
    // Le cas de l'issue : la commande a tourné, aucune écriture n'a été
    // constatée sur son tour. Rien ne se dessine comme une production.
    const v = verdict([commande('ls -la')]);
    expect(v.isWork).toBe(false);
    expect(v.items).toEqual([{ kind: 'command', label: 'ls -la', certain: false }]);
    // L'absence est DITE, jamais tue : elle est comptée comme incertaine.
    expect(v.uncertain).toBe(1);
  });

  it('un tour qui a NOMMÉ un fichier écrit est du travail, constat ou pas', () => {
    // L'autre moitié de l'issue : la carte `files` porte son propre fait, et
    // ce correctif ne la touche pas.
    const v = verdict([
      ligne({
        toolName: 'file_write',
        card: 'files',
        presented: {
          card: 'files',
          files: [{ path: 'rapport.md', action: 'created' }],
          total: 1,
          truncated: false,
        },
      }),
    ]);
    expect(v.isWork).toBe(true);
    expect(v.items).toEqual([{ kind: 'file', label: 'rapport.md', path: 'rapport.md' }]);
  });

  it('le constat d’un AUTRE tour ne crédite pas celui-ci', () => {
    // La granularité est (job, tour) : un tour qui a écrit ne fait pas passer
    // pour du travail une commande lancée au tour suivant.
    const v = verdict([commande('ls -la', { turn: 2 })], dashboard, aEcrit);
    expect(v.isWork).toBe(false);
    expect(v.items).toEqual([{ kind: 'command', label: 'ls -la', certain: false }]);
  });

  it('le constat d’un AUTRE job ne crédite pas celui-ci', () => {
    const v = verdict([commande('ls -la', { jobId: 'job-delegue' })], dashboard, aEcrit);
    expect(v.isWork).toBe(false);
  });

  it('une commande incertaine ne PORTE pas un tour que rien d’autre ne décide', () => {
    // Deux commandes sans constat restent du chat : l'incertitude ne s'ajoute
    // pas jusqu'à faire une décision.
    const v = verdict([commande('ls'), commande('pwd')]);
    expect(v.isWork).toBe(false);
    expect(v.uncertain).toBe(2);
  });

  it('mais elle paraît dans l’encart quand autre chose a décidé', () => {
    // Un fichier écrit tranche ; la commande incertaine reste listée, avec son
    // aveu, plutôt que d'être effacée du récapitulatif.
    const v = verdict([
      commande('ls -la'),
      ligne({
        toolName: 'file_write',
        card: 'files',
        presented: {
          card: 'files',
          files: [{ path: 'a.md', action: 'created' }],
          total: 1,
          truncated: false,
        },
      }),
    ]);
    expect(v.isWork).toBe(true);
    expect(v.items).toContainEqual({ kind: 'command', label: 'ls -la', certain: false });
    expect(v.uncertain).toBe(1);
  });

  it('une ligne sans job ni tour ne se rapproche d’aucun constat', () => {
    const v = verdict([commande('ls', { jobId: null, turn: null })], dashboard, aEcrit);
    expect(v.isWork).toBe(false);
    expect(v.uncertain).toBe(1);
  });
});

describe('classifyProduction — le connecteur tiers, tranché par son risque déclaré', () => {
  it('une écriture externe (`write`) est du travail', () => {
    const v = verdict([
      ligne({ toolName: 'mcp_notion__create_page', card: 'generic', riskLevel: 'write' }),
    ]);
    expect(v.isWork).toBe(true);
    expect(v.items).toEqual([
      { kind: 'external', label: 'mcp_notion__create_page', certain: true },
    ]);
    expect(v.uncertain).toBe(0);
  });

  it('une lecture externe (`read`) est du chat', () => {
    const v = verdict([
      ligne({ toolName: 'mcp_notion__search', card: 'generic', riskLevel: 'read' }),
    ]);
    expect(v.isWork).toBe(false);
    expect(v.items).toEqual([]);
  });

  it('sans risque déclaré : du chat, mais l’incertitude est comptée et nommée', () => {
    const v = verdict([
      ligne({ toolName: 'mcp_inconnu__faire', card: 'generic', riskLevel: null }),
    ]);
    expect(v.isWork).toBe(false);
    expect(v.uncertain).toBe(1);
    expect(v.items).toEqual([{ kind: 'external', label: 'mcp_inconnu__faire', certain: false }]);
  });
});

describe("classifyProduction — l'issue de l'appel", () => {
  const cartes = [
    {
      nom: 'files',
      ligne: {
        toolName: 'file_write',
        card: 'files',
        presented: {
          card: 'files',
          files: [{ path: 'a.md', action: 'created' }],
          total: 1,
          truncated: false,
        },
      },
    },
    {
      nom: 'sent',
      ligne: {
        toolName: 'send_email',
        card: 'sent',
        presented: { card: 'sent', channel: 'email', kind: 'message', target: 'paul@example.com' },
      },
    },
    {
      nom: 'terminal',
      ligne: {
        toolName: 'run_command',
        card: 'terminal',
        presented: {
          card: 'terminal',
          command: 'rm -rf out',
          exitCode: 0,
          timedOut: false,
          stdoutTail: '',
          stdoutTruncated: false,
          stderrTail: '',
          stderrTruncated: false,
        },
      },
    },
    {
      nom: 'generic write',
      ligne: { toolName: 'mcp_notion__create_page', card: 'generic', riskLevel: 'write' },
    },
  ] as const;

  for (const { nom, ligne: base } of cartes) {
    for (const issue of ['error', 'blocked', 'awaiting_approval'] as const) {
      it(`une carte ${nom} en ${issue} ne produit RIEN`, () => {
        const v = verdict([ligne({ ...base, toolOutput: echec(issue) })]);
        expect(v.isWork).toBe(false);
        expect(v.items).toEqual([]);
        expect(v.more).toBe(0);
      });
    }
  }

  it('une carte `files` en échec ne fabrique pas un fichier sans nom', () => {
    // L'échec n'a normalement PAS de charge utile : c'est exactement le cas où
    // l'ancienne version poussait un item « fichier » portant le nom de l'outil.
    const v = verdict([
      ligne({
        toolName: 'file_write',
        card: 'files',
        presented: null,
        toolOutput: echec('awaiting_approval'),
      }),
    ]);
    expect(v).toEqual({ isWork: false, items: [], uncertain: 0, more: 0, unclassified: 0 });
  });

  it('une sortie ABSENTE ne vaut ni succès ni échec : elle est dite non classable', () => {
    const v = verdict([ligne({ toolName: 'file_write', card: 'files', toolOutput: null })]);
    expect(v.isWork).toBe(false);
    expect(v.items).toEqual([]);
    expect(v.unclassified).toBe(1);
  });
});

describe('classifyProduction — les lignes sans carte (avant P1)', () => {
  it("une ligne sans carte n'est ni du chat ni du travail : elle est comptée", () => {
    const v = verdict([ligne({ toolName: 'un_vieil_outil', card: null, presented: null })]);
    expect(v.isWork).toBe(false);
    expect(v.items).toEqual([]);
    expect(v.unclassified).toBe(1);
  });

  it('elle ne fabrique jamais un encart à elle seule', () => {
    const v = verdict([ligne({ toolName: 'a', card: null }), ligne({ toolName: 'b', card: null })]);
    expect(v.isWork).toBe(false);
    expect(v.unclassified).toBe(2);
  });
});

describe('classifyProduction — le plafond', () => {
  it(`nomme ${PRODUCED_FILES_MAX} fichiers et compte les autres`, () => {
    const fichiers = Array.from({ length: 11 }, (_, i) => ({
      path: `src/f${i}.ts`,
      action: 'written' as const,
    }));
    const v = verdict([
      ligne({
        toolName: 'file_write',
        card: 'files',
        presented: { card: 'files', files: fichiers, total: 11, truncated: false },
      }),
    ]);
    expect(v.isWork).toBe(true);
    expect(v.items).toHaveLength(PRODUCED_FILES_MAX);
    expect(v.items[0]).toEqual({ kind: 'file', label: 'src/f0.ts', path: 'src/f0.ts' });
    expect(v.more).toBe(11 - PRODUCED_FILES_MAX);
  });

  it('les fichiers que le présentateur lui-même a coupés restent comptés', () => {
    const v = verdict([
      ligne({
        toolName: 'file_write',
        card: 'files',
        presented: {
          card: 'files',
          files: [{ path: 'a.ts', action: 'written' }],
          total: 40,
          truncated: true,
        },
      }),
    ]);
    expect(v.items).toEqual([{ kind: 'file', label: 'a.ts', path: 'a.ts' }]);
    expect(v.more).toBe(39);
  });

  it('les fichiers ANONYMES (carte `files` sans charge) comptent dans le plafond', () => {
    const v = verdict(
      Array.from({ length: 10 }, () =>
        ligne({ toolName: 'file_write', card: 'files', presented: null }),
      ),
    );
    expect(v.isWork).toBe(true);
    expect(v.items).toHaveLength(PRODUCED_FILES_MAX);
    expect(v.more).toBe(2);
  });

  it('une carte `files` qui dit ZÉRO fichier ne produit rien', () => {
    const v = verdict([
      ligne({
        toolName: 'file_list',
        card: 'files',
        presented: { card: 'files', files: [], total: 0, truncated: false },
      }),
    ]);
    expect(v.isWork).toBe(false);
    expect(v.items).toEqual([]);
  });
});
