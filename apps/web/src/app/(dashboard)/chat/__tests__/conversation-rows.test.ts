// conversation-rows.test.ts — les lignes d'un dossier, et ce qu'elles disent.
//
// Ce qui se prouve ici, et qu'aucun écran ne peut prouver : ce qui ATTEND la
// personne se pose sur LA BONNE ligne, une question passe avant une
// approbation, un run qui tourne n'est jamais une pastille, et une ligne au
// repos ne porte RIEN. Plus la langue de l'heure, qui change trois fois selon
// l'âge du dernier message.
//
// Mutations vérifiées (chaque fois : le test rougit) — priorité question /
// approbation inversée ; le point vert rendu quand une attente existe ;
// l'attribution faite par canal au lieu de la conversation ; la fenêtre du
// jour de la semaine étendue à sept jours.

import { describe, it, expect } from 'vitest';
import { conversationRows, conversationTimeLabel } from '../conversation-rows.ts';
import type { ChannelChatRow } from '@/lib/chat-list.ts';
import type { ConversationListRow } from '@/lib/conversation-actions.ts';

/** Vendredi 18/09/2026, 14 h 02 — l'instant de référence de tous les tests. */
const NOW = new Date(2026, 8, 18, 14, 2);

function chat(over: Partial<ChannelChatRow> = {}): ChannelChatRow {
  return {
    key: 'agent-1:telegram:42',
    channel: 'telegram',
    chatId: '42',
    name: 'Mireille',
    kind: 'private',
    currentConversationId: 'conv-1',
    conversationCount: 3,
    agentName: 'Marlow',
    agentSlug: 'marlow',
    agentAvatarUrl: null,
    updatedAt: new Date(2026, 8, 18, 9, 30),
    lastPreview: 'C’est envoyé.',
    turns: 12,
    ...over,
  };
}

function conversation(over: Partial<ConversationListRow> = {}): ConversationListRow {
  return {
    id: 'conv-9',
    channel: 'dashboard',
    chatId: null,
    title: 'Ranger les factures',
    agentId: 'agent-1',
    agentName: 'Marlow',
    agentSlug: 'marlow',
    agentAvatarUrl: null,
    updatedAt: new Date(2026, 8, 18, 11, 0),
    createdAt: new Date(2026, 8, 10, 11, 0),
    currentProject: null,
    turns: 4,
    lastPreview: 'Voilà le tableau.',
    ...over,
  };
}

describe('ce qui attend la personne, ligne par ligne @cap:reprendre-conversation/moteur', () => {
  it('pose l’attente sur SA conversation, et sur aucune autre', () => {
    const rows = conversationRows({
      chats: [
        chat({ key: 'k1', currentConversationId: 'conv-1' }),
        chat({ key: 'k2', chatId: '43', currentConversationId: 'conv-2' }),
      ],
      waiting: [{ conversationId: 'conv-2', kind: 'approval' }],
      runningConversationIds: [],
      now: NOW,
    });
    expect(rows.map((r) => r.waiting)).toEqual([null, 'approval']);
  });

  it('une question passe avant une approbation sur la MÊME conversation', () => {
    const rows = conversationRows({
      chats: [chat({ currentConversationId: 'conv-1' })],
      waiting: [
        { conversationId: 'conv-1', kind: 'approval' },
        { conversationId: 'conv-1', kind: 'question' },
      ],
      runningConversationIds: [],
      now: NOW,
    });
    // L'agent lui DEMANDE de choisir : c'est ce qui la fait revenir. Une
    // approbation est une porte qu'elle peut laisser fermée.
    expect(rows[0]!.waiting).toBe('question');
  });

  it('une attente couvre le point vert : la ligne dit ce qui appelle la personne', () => {
    const rows = conversationRows({
      chats: [chat({ currentConversationId: 'conv-1' })],
      waiting: [{ conversationId: 'conv-1', kind: 'approval' }],
      runningConversationIds: ['conv-1'],
      now: NOW,
    });
    expect(rows[0]!.waiting).toBe('approval');
    // Le run tourne bel et bien — le modèle le SAIT, et c'est l'écran qui
    // choisit de ne dessiner qu'un signe.
    expect(rows[0]!.running).toBe(true);
  });

  it('une demande sans conversation ne se pose sur AUCUNE ligne', () => {
    // Une tâche lancée par l'API, une automation : lui choisir une ligne
    // serait inventer sa provenance (invariant #4).
    const rows = conversationRows({
      chats: [chat({ currentConversationId: 'conv-1' })],
      waiting: [
        { conversationId: null, kind: 'question' },
        { conversationId: '', kind: 'question' },
      ],
      runningConversationIds: [],
      now: NOW,
    });
    expect(rows[0]!.waiting).toBeNull();
  });

  it('un `kind` inconnu ne devient pas une pastille au hasard', () => {
    const rows = conversationRows({
      chats: [chat({ currentConversationId: 'conv-1' })],
      waiting: [{ conversationId: 'conv-1', kind: 'quelque-chose-de-neuf' }],
      runningConversationIds: [],
      now: NOW,
    });
    expect(rows[0]!.waiting).toBeNull();
  });

  it('au repos, la ligne ne porte RIEN', () => {
    const rows = conversationRows({
      chats: [chat()],
      waiting: [],
      runningConversationIds: [],
      now: NOW,
    });
    expect(rows[0]!.waiting).toBeNull();
    expect(rows[0]!.running).toBe(false);
  });

  it('le run qui tourne s’allume sur SA conversation', () => {
    const rows = conversationRows({
      chats: [
        chat({ key: 'k1', currentConversationId: 'conv-1' }),
        chat({ key: 'k2', chatId: '43', currentConversationId: 'conv-2' }),
      ],
      waiting: [],
      runningConversationIds: ['conv-2'],
      now: NOW,
    });
    expect(rows.map((r) => r.running)).toEqual([false, true]);
  });
});

describe('la forme d’une ligne @cap:reprendre-conversation/moteur', () => {
  it('un chat de canal : l’agent, le nom du chat, le dernier mot, le lien', () => {
    const rows = conversationRows({
      chats: [chat({ name: 'Mireille', kind: 'private', currentConversationId: 'conv-1' })],
      now: NOW,
    });
    expect(rows[0]).toMatchObject({
      id: 'conv-1',
      href: '/chat/conv-1',
      agentName: 'Marlow',
      chatName: 'Mireille',
      preview: 'C’est envoyé.',
    });
  });

  it('un salon Discord garde son croisillon, un groupe Telegram n’en prend pas', () => {
    const rows = conversationRows({
      chats: [
        chat({ key: 'k1', channel: 'discord', name: 'general', kind: 'channel' }),
        chat({ key: 'k2', channel: 'telegram', name: 'Les voisins', kind: 'group' }),
      ],
      now: NOW,
    });
    expect(rows.map((r) => r.chatName)).toEqual(['#general', 'Les voisins']);
  });

  it('un chat sans fil courant désigné n’ouvre RIEN, plutôt qu’un lien deviné', () => {
    const rows = conversationRows({
      chats: [chat({ currentConversationId: null })],
      waiting: [{ conversationId: 'conv-1', kind: 'question' }],
      runningConversationIds: ['conv-1'],
      now: NOW,
    });
    expect(rows[0]!.href).toBeNull();
    expect(rows[0]!.id).toBeNull();
    // Et rien ne se pose dessus : on ne sait pas de QUELLE conversation il
    // s'agit, donc on ne sait pas ce qui s'y passe.
    expect(rows[0]!.waiting).toBeNull();
    expect(rows[0]!.running).toBe(false);
  });

  it('une conversation de Nodal : son titre en étiquette, son lien, son aperçu', () => {
    const rows = conversationRows({
      conversations: [conversation({ id: 'conv-9', title: 'Ranger les factures' })],
      now: NOW,
    });
    expect(rows[0]).toMatchObject({
      id: 'conv-9',
      key: 'conv-9',
      href: '/chat/conv-9',
      chatName: 'Ranger les factures',
      preview: 'Voilà le tableau.',
    });
  });

  it('un titre très long est coupé — l’étiquette ne pousse pas l’heure dehors', () => {
    const titre = 'Reprendre le dossier de la cave et lister tout ce qui traîne depuis mars';
    const rows = conversationRows({ conversations: [conversation({ title: titre })], now: NOW });
    expect(rows[0]!.chatName.length).toBeLessThanOrEqual(41);
    expect(rows[0]!.chatName.endsWith('…')).toBe(true);
  });

  it('un fil que personne n’a nommé s’écrit « Untitled », jamais vide', () => {
    const rows = conversationRows({ conversations: [conversation({ title: '' })], now: NOW });
    expect(rows[0]!.chatName).toBe('Untitled');
  });

  it('sans dernier mot, la seconde ligne n’existe pas', () => {
    const rows = conversationRows({ chats: [chat({ lastPreview: null })], now: NOW });
    expect(rows[0]!.preview).toBeNull();
  });
});

describe('l’heure d’une ligne @cap:reprendre-conversation/moteur', () => {
  it('aujourd’hui : l’heure', () => {
    expect(conversationTimeLabel(new Date(2026, 8, 18, 9, 30), NOW)).toBe('09:30');
  });

  it('hier : le JOUR, même dix minutes plus tôt — le calendrier, pas 24 h', () => {
    const veille = new Date(2026, 8, 17, 23, 50);
    const minuitPasse = new Date(2026, 8, 18, 0, 10);
    const label = conversationTimeLabel(veille, minuitPasse);
    expect(label).toBe(veille.toLocaleDateString(undefined, { weekday: 'short' }));
    expect(label).not.toMatch(/\d\d:\d\d/);
  });

  it('six jours en arrière : encore le jour ; sept : la date', () => {
    const six = new Date(2026, 8, 12, 9, 30);
    const sept = new Date(2026, 8, 11, 9, 30);
    expect(conversationTimeLabel(six, NOW)).toBe(
      six.toLocaleDateString(undefined, { weekday: 'short' }),
    );
    // Au-delà de six jours, « Fri » redeviendrait ambigu — celui de cette
    // semaine, ou celui d'avant ? C'est la date qui s'écrit, et elle porte le
    // quantième.
    const loin = conversationTimeLabel(sept, NOW)!;
    expect(loin).toContain('11');
    expect(loin).not.toBe(sept.toLocaleDateString(undefined, { weekday: 'short' }));
  });

  it('une autre année porte son année ; l’année courante ne la porte pas', () => {
    expect(conversationTimeLabel(new Date(2025, 8, 11, 9, 30), NOW)).toContain('2025');
    expect(conversationTimeLabel(new Date(2026, 0, 11, 9, 30), NOW)).not.toContain('2026');
  });

  it('sans date, RIEN — jamais un tiret qu’on lirait comme une valeur', () => {
    expect(conversationTimeLabel(null, NOW)).toBeNull();
    expect(conversationRows({ chats: [chat({ updatedAt: null })], now: NOW })[0]!.time).toBeNull();
  });
});
