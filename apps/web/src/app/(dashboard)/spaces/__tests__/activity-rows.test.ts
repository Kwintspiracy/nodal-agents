// activity-rows.test.ts — UNE liste, deux sortes de lignes (#143).
//
// Ce que ces cas tiennent, et que rien d'autre ne tient : les deux sortes sont
// triées ENSEMBLE, dans une seule histoire du projet. Empiler les conversations
// puis les runs raconterait deux fois la même semaine, et c'est exactement ce
// qu'on lisait avant — les conversations dans Spaces, les sessions dans Code.
//
// Ils tiennent aussi ce que CHAQUE ligne ouvre : un fil pour une conversation,
// la page du run pour une session qui n'en a pas. Une session n'a pas de fil ;
// lui en inventer un mènerait à une page vide.

import { describe, it, expect } from 'vitest';
import {
  activityRows,
  conversationSubline,
  sessionSubline,
  sessionTitle,
  stageLabel,
} from '../activity-rows.ts';
import type { ProjectActivityConversation, ProjectActivitySession } from '@/lib/project-actions.ts';

const conversation = (
  over: Partial<ProjectActivityConversation> & { id: string },
): ProjectActivityConversation => ({
  channel: 'dashboard',
  title: 'Fix the release check on Windows',
  agentName: 'Lead Dev',
  agentAvatarUrl: null,
  lastPreview: 'Tests green, ready for review',
  sessions: 2,
  updatedAt: new Date('2026-09-19T14:02:00.000Z'),
  running: false,
  unread: false,
  ...over,
});

const session = (
  over: Partial<ProjectActivitySession> & { id: string },
): ProjectActivitySession => ({
  agentName: 'Lead Dev',
  agentAvatarUrl: null,
  provider: 'claude',
  origin: 'cli',
  status: 'awaiting_approval',
  task: 'approval needed to write 3 files',
  createdAt: new Date('2026-09-19T13:47:00.000Z'),
  ...over,
});

describe('activityRows @cap:travailler-sur-des-fichiers/ecran', () => {
  it('mêle les deux sortes dans UNE liste, de la plus récente à la plus ancienne', () => {
    const rows = activityRows({
      conversations: [
        conversation({ id: 'c-vieille', updatedAt: new Date('2026-09-17T09:00:00.000Z') }),
        conversation({ id: 'c-recente', updatedAt: new Date('2026-09-19T14:02:00.000Z') }),
      ],
      sessions: [session({ id: 'j-milieu', createdAt: new Date('2026-09-18T13:47:00.000Z') })],
    });

    expect(rows.map((r) => r.key)).toEqual([
      'conversation-c-recente',
      'session-j-milieu',
      'conversation-c-vieille',
    ]);
  });

  it('une ligne de CONVERSATION ouvre le fil ; une SESSION ouvre la page du run', () => {
    const rows = activityRows({
      conversations: [conversation({ id: 'c-1' })],
      sessions: [session({ id: 'j-1' })],
    });
    const fil = rows.find((r) => r.key === 'conversation-c-1')!;
    const run = rows.find((r) => r.key === 'session-j-1')!;

    expect(fil.href).toBe('/chat/c-1');
    // La page du run de code existe toujours : c'est la liste qui a disparu.
    expect(run.href).toBe('/code/j-1');
  });

  it('chaque ligne montre SON agent : il change d’une ligne à l’autre dans un projet', () => {
    const rows = activityRows({
      conversations: [conversation({ id: 'c-1', agentName: 'Lead Dev' })],
      sessions: [session({ id: 'j-1', agentName: 'Dev' })],
    });
    expect(rows.map((r) => r.agent?.name)).toEqual(['Lead Dev', 'Dev']);
  });

  it('ce qui ATTEND se pose sur la ligne qui le porte, et sur aucune autre', () => {
    const rows = activityRows({
      conversations: [conversation({ id: 'c-1' }), conversation({ id: 'c-2' })],
      sessions: [session({ id: 'j-1', status: 'completed' })],
      waiting: [
        { conversationId: 'c-1', rootJobId: 'j-9', kind: 'question' },
        { conversationId: null, rootJobId: 'j-1', kind: 'approval' },
      ],
    });

    expect(rows.find((r) => r.key === 'conversation-c-1')!.waiting).toBe('question');
    expect(rows.find((r) => r.key === 'conversation-c-2')!.waiting).toBeNull();
    expect(rows.find((r) => r.key === 'session-j-1')!.waiting).toBe('approval');
  });

  it('une demande sans conversation NI job de tête ne se pose sur aucune ligne', () => {
    const rows = activityRows({
      conversations: [conversation({ id: 'c-1' })],
      sessions: [session({ id: 'j-1', status: 'completed' })],
      waiting: [{ conversationId: null, rootJobId: null, kind: 'approval' }],
    });
    expect(rows.every((r) => r.waiting === null)).toBe(true);
  });

  it('un run BLOQUÉ sur une approbation le dit, même sans demande enregistrée', () => {
    const rows = activityRows({
      conversations: [],
      sessions: [session({ id: 'j-1', status: 'awaiting_approval' })],
    });
    // Sinon un run arrêté sur une approbation expirée s'afficherait éteint,
    // exactement comme un run terminé.
    expect(rows[0]!.waiting).toBe('approval');
    expect(rows[0]!.running).toBe(false);
  });

  it('un run VIVANT allume son point, un run fini ne l’allume pas', () => {
    const rows = activityRows({
      conversations: [],
      sessions: [
        session({ id: 'j-vivant', status: 'processing', task: '' }),
        session({ id: 'j-fini', status: 'completed', task: '' }),
      ],
    });
    expect(rows.find((r) => r.key === 'session-j-vivant')!.running).toBe(true);
    expect(rows.find((r) => r.key === 'session-j-fini')!.running).toBe(false);
  });

  // Mutation : `unread: c.unread` figé à `false` dans `activity-rows.ts` →
  // ce cas rougit sur la première assertion.
  it('le NON LU d’un fil arrive jusqu’à la ligne ; un run n’est jamais non lu', () => {
    const rows = activityRows({
      conversations: [
        conversation({ id: 'c-non-lue', unread: true }),
        conversation({ id: 'c-lue', unread: false }),
      ],
      // Un run n'a pas d'état de lecture : la table des marqueurs ne porte que
      // des fils. Sa ligne le dit en clair plutôt que de l'emprunter ailleurs.
      sessions: [session({ id: 'j-1' })],
    });

    expect(rows.find((r) => r.key === 'conversation-c-non-lue')!.unread).toBe(true);
    expect(rows.find((r) => r.key === 'conversation-c-lue')!.unread).toBe(false);
    expect(rows.find((r) => r.key === 'session-j-1')!.unread).toBe(false);
  });

  it('un fil que personne n’a nommé s’écrit « Untitled », jamais un titre vide', () => {
    const rows = activityRows({
      conversations: [conversation({ id: 'c-1', title: '' })],
      sessions: [],
    });
    expect(rows[0]!.chatName).toBe('Untitled');
  });
});

describe('sessionTitle @cap:travailler-sur-des-fichiers/ecran', () => {
  it('nomme le harnais et la provenance', () => {
    expect(sessionTitle({ provider: 'claude', origin: 'cli' })).toBe(
      'Claude Code session · from the CLI',
    );
    expect(sessionTitle({ provider: 'codex', origin: 'mcp' })).toBe('Codex session · from MCP');
  });

  it('sans harnais connu, « Session » — jamais un nom de produit deviné', () => {
    expect(sessionTitle({ provider: null, origin: 'mcp' })).toBe('Session · from MCP');
  });
});

describe('les sous-lignes de l’activité @cap:travailler-sur-des-fichiers/ecran', () => {
  it('une conversation dit l’agent, la dernière phrase et ses sessions', () => {
    expect(conversationSubline(conversation({ id: 'c-1' }))).toBe(
      'Lead Dev · “Tests green, ready for review” · 2 sessions inside',
    );
  });

  it('un fil sans session ne dit PAS « 0 sessions inside »', () => {
    const texte = conversationSubline(conversation({ id: 'c-1', sessions: 0 }))!;
    expect(texte).not.toContain('session');
    expect(texte).toBe('Lead Dev · “Tests green, ready for review”');
  });

  it('le singulier ne s’écrit jamais au pluriel', () => {
    expect(conversationSubline(conversation({ id: 'c-1', sessions: 1 }))).toContain(
      '1 session inside',
    );
  });

  it('un fil dont rien n’est connu n’écrit pas de sous-ligne du tout', () => {
    expect(
      conversationSubline(
        conversation({ id: 'c-1', agentName: null, lastPreview: null, sessions: 0 }),
      ),
    ).toBeNull();
  });

  it('une session dit qu’elle est SEULE, et où elle en est', () => {
    expect(sessionSubline(session({ id: 'j-1' }))).toBe(
      'No conversation · Blocked · approval needed to write 3 files',
    );
  });

  it('un statut que le produit ne connaît pas passe TEL QUEL, jamais traduit au hasard', () => {
    expect(stageLabel('some_new_status')).toBe('some_new_status');
    expect(stageLabel(null)).toBeNull();
  });
});
