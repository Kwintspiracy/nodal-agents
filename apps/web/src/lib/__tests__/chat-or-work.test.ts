// chat-or-work.test.ts — LES GARDES du plan (P7), une par `it`.
//
// Chaque cas est une phrase du plan : « lire, chercher, noter la mémoire =
// chat », « un fichier, un envoi ailleurs, une commande, le harnais, une
// écriture externe = travail ». Les lignes sont celles que P1 persiste
// vraiment (carte + charge utile validée par le schéma partagé), pas des
// formes inventées pour l'occasion : une charge hors forme serait rejetée par
// `parsePresented` et le test le verrait.

import { describe, it, expect } from 'vitest';
import { classifyProduction, PRODUCED_FILES_MAX } from '../chat-or-work.ts';
import type { ClassifiableRow } from '../chat-or-work.ts';

/** Le fil du dashboard, sauf quand un cas parle d'un canal. */
const dashboard = { channel: 'dashboard', chatId: null };
const telegram = { channel: 'telegram', chatId: '4242' };

const ligne = (over: Partial<ClassifiableRow>): ClassifiableRow => ({
  jobId: 'job-tete',
  toolName: 'un_outil',
  card: null,
  presented: null,
  riskLevel: null,
  toolInput: {},
  ...over,
});

const verdict = (
  rows: ClassifiableRow[],
  conversation: { channel: string; chatId: string | null } = dashboard,
) => classifyProduction({ conversation, rows });

describe('classifyProduction — ce qui reste du chat', () => {
  it('« bonjour » : aucune ligne, donc rien à montrer', () => {
    const v = verdict([]);
    expect(v).toEqual({ isWork: false, items: [], uncertain: 0, more: 0 });
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

  it('une commande exécutée est du travail', () => {
    const v = verdict([
      ligne({
        toolName: 'run_command',
        card: 'terminal',
        presented: {
          card: 'terminal',
          command: 'pnpm build',
          exitCode: 0,
          timedOut: false,
          stdoutTail: 'done',
          stdoutTruncated: false,
          stderrTail: '',
          stderrTruncated: false,
        },
      }),
    ]);
    expect(v.isWork).toBe(true);
    expect(v.items).toEqual([{ kind: 'command', label: 'pnpm build' }]);
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
