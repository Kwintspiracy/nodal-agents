// chat-list.test.ts — les canaux d'un côté, les conversations de l'autre.
//
// Le cas qui a motivé ce découpage : sur la base de Quentin, le 08/09/2026, un
// SEUL chat Telegram portait 45 conversations, une par fil ouvert au fil des
// mois. Elles noyaient les dix conversations du dashboard, et chacune
// s'affichait sous le titre de son premier message.

import { describe, it, expect } from 'vitest';
import { groupChatLists } from '../chat-list.ts';
import type { ConversationListRow } from '../conversation-actions.ts';

const row = (over: Partial<ConversationListRow> & { id: string }): ConversationListRow => ({
  channel: 'dashboard',
  chatId: null,
  title: 'un titre',
  agentId: 'a1',
  agentName: 'Alfred',
  agentSlug: 'alfred',
  agentAvatarUrl: null,
  updatedAt: new Date('2026-09-08T01:00:00Z'),
  createdAt: new Date('2026-08-26T13:50:00Z'),
  currentProject: null,
  turns: 3,
  lastPreview: null,
  unread: false,
  ...over,
});

describe('groupChatLists', () => {
  it('un chat qui porte 45 fils tient sur UNE ligne', () => {
    const rows = Array.from({ length: 45 }, (_, i) =>
      row({ id: `c${i}`, channel: 'telegram', chatId: '199791464' }),
    );

    const { channels, dashboard } = groupChatLists(rows);
    expect(channels).toHaveLength(1);
    expect(channels[0]?.conversationCount).toBe(45);
    expect(dashboard).toHaveLength(0);
  });

  it('le fil courant emporte SON aperçu et SES tours, pas ceux du fil remué', () => {
    // `lastPreview` et `turns` décrivent le fil courant : les laisser sur la
    // première ligne reçue ferait dire à la ligne du chat le dernier mot d'un
    // AUTRE fil que celui qu'elle ouvre.
    const { channels } = groupChatLists(
      [
        row({
          id: 'A-remue',
          channel: 'telegram',
          chatId: '199791464',
          lastPreview: 'le dernier mot du vieux fil',
          turns: 12,
        }),
        row({
          id: 'B-courant',
          channel: 'telegram',
          chatId: '199791464',
          lastPreview: 'le dernier mot du fil courant',
          turns: 1,
        }),
      ],
      {},
      { 'a1:telegram:199791464': 'B-courant' },
    );
    expect(channels[0]?.lastPreview).toBe('le dernier mot du fil courant');
    expect(channels[0]?.turns).toBe(1);
  });

  it('SANS désignation : aucun lien, et l’écran a de quoi le DIRE', () => {
    // Revue Codex PR #48, passe 7. Le repli d'avant reconstituait une
    // estimation locale et la présentait comme le fil courant — sans erreur,
    // sans indicateur, avec le lien et l'aperçu du mauvais fil. C'est le repli
    // silencieux qu'interdit l'invariant #4 : on ne devine plus, on le dit.
    const { channels, missingCurrent } = groupChatLists([
      row({ id: 'A', channel: 'telegram', chatId: '199791464' }),
      row({ id: 'B', channel: 'telegram', chatId: '199791464' }),
    ]);
    expect(channels).toHaveLength(1);
    expect(channels[0]?.currentConversationId).toBeNull();
    expect(channels[0]?.lastPreview, 'aucun aperçu emprunté à un autre fil').toBeNull();
    expect(channels[0]?.turns).toBe(0);
    // Le chat reste COMPTÉ : il existe, on ne sait pas où il mène.
    expect(channels[0]?.conversationCount).toBe(2);
    expect(missingCurrent).toBe(true);
  });

  it('un chat que la FENÊTRE n’a pas rapporté est compté, pas escamoté', () => {
    // Revue Codex PR #48, passe 8. La liste est plafonnée : si 200 autres
    // conversations passent devant, un chat entier n'a plus aucune ligne — et
    // il disparaissait sans que rien ne le dise.
    const { channels, hiddenByWindow } = groupChatLists(
      [row({ id: 'A', channel: 'telegram', chatId: '111' })],
      {},
      { 'a1:telegram:111': 'A', 'a1:telegram:222': 'B', 'a1:telegram:333': 'C' },
      ['a1:telegram:111', 'a1:telegram:222', 'a1:telegram:333'],
    );
    expect(channels).toHaveLength(1);
    expect(hiddenByWindow, 'deux chats listables, absents de la fenêtre').toBe(2);
  });

  it('un chat DÉSIGNÉ mais non listable n’est pas compté comme manquant', () => {
    // Revue Codex PR #48, passe 9. La désignation ne filtre pas l'origine —
    // elle copie le runner. Un chat dont le seul fil est un entretien d'accueil
    // y figure donc, alors que la liste ne l'accepterait jamais : le compter
    // faisait dire à l'écran qu'un plafond l'avait écarté. Le plafond n'y est
    // pour rien.
    const { hiddenByWindow } = groupChatLists(
      [row({ id: 'A', channel: 'telegram', chatId: '111' })],
      {},
      { 'a1:telegram:111': 'A', 'a1:telegram:999': 'ONBOARDING' },
      // Seul le premier est listable.
      ['a1:telegram:111'],
    );
    expect(hiddenByWindow).toBe(0);
  });

  it('un chat qui APPARAÎT entre les deux lectures ne compense pas un chat manquant', () => {
    // Revue Codex PR #48, passe 9. Les deux lectures ne sont pas atomiques :
    // soustraire leurs tailles laissait un chat créé entre elles annuler
    // exactement un chat absent — 1 − 1 = 0, et le silence redevenait
    // invisible. On compte les absents un par un.
    const { channels, hiddenByWindow } = groupChatLists(
      // La liste voit B, que la désignation ne connaît pas encore.
      [row({ id: 'B1', channel: 'telegram', chatId: '222' })],
      {},
      { 'a1:telegram:111': 'A1' },
      ['a1:telegram:111'],
    );
    expect(channels).toHaveLength(1);
    expect(hiddenByWindow, 'A manque toujours, quoi qu’il arrive à B').toBe(1);
  });

  it('rien de caché quand la fenêtre rapporte tous les chats listables', () => {
    const { hiddenByWindow } = groupChatLists(
      [
        row({ id: 'A', channel: 'telegram', chatId: '111' }),
        row({ id: 'B', channel: 'telegram', chatId: '222' }),
      ],
      {},
      { 'a1:telegram:111': 'A', 'a1:telegram:222': 'B' },
      ['a1:telegram:111', 'a1:telegram:222'],
    );
    expect(hiddenByWindow).toBe(0);
  });

  it('AUCUNE ligne mais des chats listables : le compte les dit quand même', () => {
    // Le cas qui justifie que la section s'affiche vide : sans ce compte, la
    // page ne montrerait rien du tout et n'aurait rien à expliquer.
    const { channels, hiddenByWindow } = groupChatLists([], {}, { 'a1:telegram:111': 'A' }, [
      'a1:telegram:111',
    ]);
    expect(channels).toHaveLength(0);
    expect(hiddenByWindow).toBe(1);
  });

  it('un chat listable SANS désignation a une ligne : il n’est pas « caché »', () => {
    // Revue Codex PR #48, passe 10. Aucun des cinq tests ne couvrait ce
    // croisement, et c'est celui où l'écran pourrait se contredire : dire à la
    // fois « ce chat n'est pas listé » et « le voici, indisponible ».
    //
    // Il a une ligne, donc il n'est pas caché ; il n'a pas de fil courant, donc
    // il est marqué indisponible. Les deux compteurs disent des choses
    // différentes du même chat, et c'est cohérent.
    const { channels, hiddenByWindow, missingCurrent } = groupChatLists(
      [row({ id: 'A', channel: 'telegram', chatId: '111' })],
      {},
      {},
      ['a1:telegram:111'],
    );
    expect(channels).toHaveLength(1);
    expect(channels[0]?.currentConversationId, 'aucun fil désigné').toBeNull();
    expect(missingCurrent, 'l’écran le dit indisponible').toBe(true);
    expect(hiddenByWindow, 'mais il a bien une ligne : rien n’est caché').toBe(0);
  });

  it('avec désignation partout, l’écran n’a rien à signaler', () => {
    const { missingCurrent } = groupChatLists(
      [row({ id: 'A', channel: 'telegram', chatId: '199791464' })],
      {},
      { 'a1:telegram:199791464': 'A' },
    );
    expect(missingCurrent).toBe(false);
  });

  it('la RÉCENCE de la ligne reste celle du chat, pas celle du fil courant', () => {
    // Ce que la liste trie, c'est « quel chat a bougé en dernier » — un fil
    // ancien remué a bel et bien fait bouger ce chat. Rabattre la ligne sur
    // l'`updatedAt` du seul fil courant ferait descendre un chat actif.
    const { channels } = groupChatLists([
      row({
        id: 'A-remue',
        channel: 'telegram',
        chatId: '199791464',
        createdAt: new Date('2026-09-08T09:00:00Z'),
        updatedAt: new Date('2026-09-08T09:30:00Z'),
      }),
      row({
        id: 'B-courant',
        channel: 'telegram',
        chatId: '199791464',
        createdAt: new Date('2026-09-08T09:15:00Z'),
        updatedAt: new Date('2026-09-08T09:16:00Z'),
      }),
    ]);
    expect(channels[0]?.updatedAt).toEqual(new Date('2026-09-08T09:30:00Z'));
  });

  it('la DÉSIGNATION de la base gagne sur tout calcul local', () => {
    // Revue Codex PR #48, passe 6. Trois façons dont le calcul local se
    // trompait — fenêtre de 200 lignes, millisecondes contre microsecondes,
    // `NULL` que PostgreSQL place DEVANT en tri décroissant — et une seule
    // réponse : c'est la base qui désigne, avec la règle du runner.
    //
    // Ici la ligne « la plus récente » selon toute lecture locale est A ; la
    // base désigne B. C'est B qui gagne.
    const { channels } = groupChatLists(
      [
        row({
          id: 'A',
          channel: 'telegram',
          chatId: '199791464',
          createdAt: new Date('2026-09-08T10:00:00Z'),
        }),
        row({
          id: 'B',
          channel: 'telegram',
          chatId: '199791464',
          createdAt: new Date('2026-09-01T10:00:00Z'),
        }),
      ],
      {},
      { 'a1:telegram:199791464': 'B' },
    );
    expect(channels[0]?.currentConversationId).toBe('B');
  });

  it('un fil courant HORS de la fenêtre reste celui que la ligne ouvre', () => {
    // La liste est coupée à 200 lignes triées par `updated_at` : le fil courant
    // peut ne pas en faire partie. La ligne doit quand même y mener — sinon
    // elle ouvre un fil que le prochain message n'alimentera pas, ce qui est
    // exactement le défaut de la passe 5.
    const { channels } = groupChatLists(
      [row({ id: 'dans-la-fenetre', channel: 'telegram', chatId: '199791464' })],
      {},
      { 'a1:telegram:199791464': 'hors-fenetre' },
    );
    expect(channels[0]?.currentConversationId).toBe('hors-fenetre');
    // Et l'écran ne prête pas à ce fil l'aperçu d'un autre : il se tait.
    expect(channels[0]?.lastPreview).toBeNull();
    expect(channels[0]?.turns).toBe(0);
  });

  it('la ligne garde l’aperçu du fil courant quand il EST chargé', () => {
    const { channels } = groupChatLists(
      [
        row({
          id: 'A',
          channel: 'telegram',
          chatId: '199791464',
          lastPreview: 'le vieux fil',
          turns: 9,
        }),
        row({
          id: 'B',
          channel: 'telegram',
          chatId: '199791464',
          lastPreview: 'le fil courant',
          turns: 2,
        }),
      ],
      {},
      { 'a1:telegram:199791464': 'B' },
    );
    expect(channels[0]?.currentConversationId).toBe('B');
    expect(channels[0]?.lastPreview).toBe('le fil courant');
    expect(channels[0]?.turns).toBe(2);
  });

  it('un chat par CHAT, pas par canal : le privé et le groupe restent deux lignes', () => {
    const { channels } = groupChatLists([
      row({ id: 'p', channel: 'telegram', chatId: '199791464' }),
      row({ id: 'g', channel: 'telegram', chatId: '-1003782553674' }),
    ]);
    expect(channels).toHaveLength(2);
    expect(channels.map((c) => c.chatId).sort()).toEqual(['-1003782553674', '199791464']);
  });

  it('deux canaux qui partagent un identifiant ne se confondent pas', () => {
    const { channels } = groupChatLists([
      row({ id: 'a', channel: 'telegram', chatId: '42' }),
      row({ id: 'b', channel: 'discord', chatId: '42' }),
    ]);
    expect(channels).toHaveLength(2);
    expect(channels.map((c) => c.key).sort()).toEqual(['a1:discord:42', 'a1:telegram:42']);
  });

  it('deux AGENTS sur le même chat gardent chacun leur fil', () => {
    // Le runner identifie un fil par (entité, agent, canal, chat) — voir
    // `resolveConversation`. Grouper sur le seul couple canal/chat fusionnait
    // deux bots parlant au même utilisateur, et le second fil disparaissait de
    // l'écran (revue Codex, PR #48, passe 2).
    const { channels } = groupChatLists(
      [
        row({ id: 'f1', channel: 'telegram', chatId: '199791464', agentId: 'alfred' }),
        row({ id: 'f2', channel: 'telegram', chatId: '199791464', agentId: 'hermes' }),
      ],
      {},
      { 'alfred:telegram:199791464': 'f1', 'hermes:telegram:199791464': 'f2' },
    );
    expect(channels).toHaveLength(2);
    expect(channels.map((c) => c.currentConversationId).sort()).toEqual(['f1', 'f2']);
  });

  it('le nom vient de l’allowlist, jamais du premier message', () => {
    const { channels } = groupChatLists(
      [
        row({
          id: 'g',
          channel: 'telegram',
          chatId: '-1003782553674',
          title: 'Fais-moi une app en HTML, en récupérant l’API de IGDB',
        }),
      ],
      { 'telegram:-1003782553674': { name: 'Mathilde', kind: 'group' } },
    );
    expect(channels[0]?.name).toBe('Mathilde');
  });

  it('la NATURE du chat remonte : elle distingue deux homonymes', () => {
    // Sur Discord et Slack, l'allowlist enregistre le même `requester_name`
    // pour le privé et pour le salon d'une même personne. Sans le `kind`, deux
    // lignes portaient exactement le même libellé (constaté à l'écran).
    const { channels } = groupChatLists(
      [
        row({ id: 'p', channel: 'discord', chatId: '1525500444439220334' }),
        row({ id: 's', channel: 'discord', chatId: '1511202553420054671' }),
      ],
      {
        'discord:1525500444439220334': { name: 'Kwintspiracy', kind: 'private' },
        'discord:1511202553420054671': { name: 'Kwintspiracy', kind: 'channel' },
      },
    );
    expect(channels.map((c) => c.kind).sort()).toEqual(['channel', 'private']);
  });

  it('sans nom connu : null — l’écran montrera l’identifiant, qui est au moins vrai', () => {
    const { channels } = groupChatLists([
      row({ id: 'p', channel: 'telegram', chatId: '199791464' }),
    ]);
    expect(channels[0]?.name).toBeNull();
  });

  it('les conversations du dashboard restent entières et dans leur ordre', () => {
    const { channels, dashboard } = groupChatLists([
      row({ id: 'd1' }),
      row({ id: 't1', channel: 'telegram', chatId: '199791464' }),
      row({ id: 'd2' }),
    ]);
    expect(channels).toHaveLength(1);
    expect(dashboard.map((d) => d.id)).toEqual(['d1', 'd2']);
  });

  it('une conversation de canal SANS chat ne disparaît pas : elle reste en bas', () => {
    // Elle ne peut être rattachée à aucun chat. La perdre serait pire que la
    // ranger au mauvais endroit.
    const { channels, dashboard } = groupChatLists([
      row({ id: 'orphelin', channel: 'telegram', chatId: null }),
    ]);
    expect(channels).toHaveLength(0);
    expect(dashboard.map((d) => d.id)).toEqual(['orphelin']);
  });
});
