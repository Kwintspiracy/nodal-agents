// chat-folders.test.ts — ce que le menu Chat PROMET (#135).
//
// Deux promesses, et ce sont les seules qui comptent :
//   1. chaque attente est rangée dans LE dossier d'où elle vient. Une
//      approbation Telegram comptée dans « Nodal chats » envoie la personne
//      chercher au mauvais endroit, et le chiffre qu'elle lit est faux des
//      deux côtés à la fois ;
//   2. la pastille compte ce qui attend la PERSONNE, et rien d'autre. Un run
//      qui tourne allume un point, jamais un nombre.
//
// Les assertions portent sur les LIGNES rendues — clé, libellé, lien, compte,
// point, état actif — jamais sur le nombre d'appels d'une fonction.

import { describe, it, expect } from 'vitest';
import {
  chatFolders,
  chatWaitingTotal,
  folderThreads,
  threadCallsFor,
  threadDotTone,
  FOLDER_THREADS_MAX,
  FOLDER_THREADS_PROBE,
  unfoldedRows,
  folderOfJobChannel,
  folderOfWork,
  DASHBOARD_FOLDER,
  MCP_FOLDER,
  RUNNING_JOB_STATUSES,
  type FolderThreadSource,
  type WorkOrigin,
} from '../chat-folders.ts';

/** Une attente portée par un job, et par AUCUNE conversation. */
function waiting(...channels: (string | null)[]): WorkOrigin[] {
  return channels.map((jobChannel) => ({ jobChannel, conversationChannel: null }));
}

/**
 * Une attente portée par un job d'un canal, DANS une conversation d'un autre —
 * ce qu'un délégué du tableau des tâches est toujours (#148).
 */
function waitingInConversation(
  jobChannel: string | null,
  conversationChannel: string | null,
  n = 1,
): WorkOrigin[] {
  return Array.from({ length: n }, () => ({ jobChannel, conversationChannel }));
}

function folders(input: Partial<Parameters<typeof chatFolders>[0]> = {}) {
  return chatFolders({
    channels: [],
    waiting: [],
    running: {},
    externalRuns: 0,
    pathname: '/chat',
    folderParam: null,
    ...input,
  });
}

function byKey(rows: ReturnType<typeof chatFolders>, key: string) {
  const row = rows.find((r) => r.key === key);
  if (!row) throw new Error(`no folder ${key} among ${rows.map((r) => r.key).join(', ')}`);
  return row;
}

describe("l'attribution d'une attente à son dossier @cap:reprendre-conversation/moteur", () => {
  it('range une demande sur son canal, et pas ailleurs', () => {
    const rows = folders({
      channels: ['telegram', 'slack'],
      waiting: waiting('telegram', 'telegram', 'slack'),
    });
    expect(byKey(rows, 'telegram').waiting).toBe(2);
    expect(byKey(rows, 'slack').waiting).toBe(1);
    expect(byKey(rows, DASHBOARD_FOLDER).waiting).toBe(0);
  });

  it('range une demande du dashboard dans « Nodal chats », jamais dans un canal', () => {
    const rows = folders({ channels: ['telegram'], waiting: waiting('dashboard', 'dashboard') });
    expect(byKey(rows, DASHBOARD_FOLDER).waiting).toBe(2);
    expect(byKey(rows, 'telegram').waiting).toBe(0);
  });

  it('ne range PAS une demande d’un run programmé : une automation n’est pas un dialogue', () => {
    // Quentin, 17/09 : « il n'y a aucun échange entre l'utilisateur et
    // l'agent » — pas de dossier Routines sous Channels. La demande reste
    // entière sur /approvals.
    expect(folderOfJobChannel('cron')).toBeNull();
    const rows = folders({ waiting: waiting('cron') });
    expect(rows.map((r) => r.key)).toEqual([DASHBOARD_FOLDER]);
    expect(rows.every((r) => r.waiting === 0)).toBe(true);
  });

  it('ne range dans AUCUN dossier ce qui ne vient d’aucun d’eux', () => {
    // `internal` = un agent qui appelle un agent, `webhook` = un déclencheur,
    // `null` = un job disparu sous la jointure. Aucun n'est un dossier de chat.
    expect(folderOfJobChannel('internal')).toBeNull();
    expect(folderOfJobChannel('webhook')).toBeNull();
    expect(folderOfJobChannel(null)).toBeNull();
    const rows = folders({ channels: ['telegram'], waiting: waiting('internal', 'webhook', null) });
    expect(rows.every((r) => r.waiting === 0)).toBe(true);
  });
});

describe("l'attente suit le canal de SA CONVERSATION @cap:reprendre-conversation/moteur", () => {
  // #148. Un job délégué que le tableau des tâches crée porte
  // `channel = 'task-board'` — le dossier de personne — et le
  // `conversation_id` de son créateur. La LIGNE de la conversation s'allumait,
  // la pastille du dossier comptait zéro. La règle lit la conversation d'abord.

  it('range dans le dossier du canal de la conversation, pas dans celui du job', () => {
    const rows = folders({
      channels: ['telegram'],
      waiting: waitingInConversation('task-board', 'telegram'),
    });
    expect(byKey(rows, 'telegram').waiting).toBe(1);
    expect(byKey(rows, DASHBOARD_FOLDER).waiting).toBe(0);
  });

  it('fait compter au total du menu exactement ce que la pastille affiche', () => {
    const input = {
      channels: ['telegram'],
      waiting: waitingInConversation('task-board', 'telegram', 3),
      running: {},
      externalRuns: 0,
    };
    const rows = chatFolders({ ...input, pathname: '/chat', folderParam: null });
    expect(byKey(rows, 'telegram').waiting).toBe(3);
    expect(chatWaitingTotal(input)).toBe(3);
  });

  it('ouvre le dossier du canal de la conversation même sans conversation lue', () => {
    // Sans cela, la seule attente d'un canal disparaîtrait du menu en silence
    // parce que le job qui la porte n'a pas son canal.
    const rows = folders({ channels: [], waiting: waitingInConversation('task-board', 'slack') });
    expect(byKey(rows, 'slack').waiting).toBe(1);
  });

  it('retombe sur le canal du job quand le travail n’a pas de conversation', () => {
    expect(folderOfWork({ jobChannel: 'telegram', conversationChannel: null })).toBe('telegram');
    // Un délégué du tableau des tâches SANS conversation n'est dans aucun
    // dossier : rien d'autre ne dit d'où il vient (invariant #4).
    expect(folderOfWork({ jobChannel: 'task-board', conversationChannel: null })).toBeNull();
    const rows = folders({ channels: ['telegram'], waiting: waiting('task-board') });
    expect(rows.every((r) => r.waiting === 0)).toBe(true);
  });

  it('suit la conversation même quand le job a un canal de dossier, lui aussi', () => {
    // La conversation décide, toujours — pas le plus « précis » des deux. Une
    // règle qui choisirait au cas par cas ne serait plus lisible.
    expect(folderOfWork({ jobChannel: 'telegram', conversationChannel: 'dashboard' })).toBe(
      DASHBOARD_FOLDER,
    );
    expect(folderOfWork({ jobChannel: 'dashboard', conversationChannel: 'slack' })).toBe('slack');
  });

  it('ne range nulle part un travail dont la conversation n’a aucun dossier', () => {
    // Une conversation de `cron` n'est pas un endroit où l'on parle : le
    // travail reste entier sur /approvals, dans aucun dossier de chat.
    expect(folderOfWork({ jobChannel: 'task-board', conversationChannel: 'cron' })).toBeNull();
    const rows = folders({
      channels: ['telegram'],
      waiting: waitingInConversation('task-board', 'cron'),
    });
    expect(rows.every((r) => r.waiting === 0)).toBe(true);
  });
});

describe('les dossiers qui existent @cap:reprendre-conversation/moteur', () => {
  it('donne un dossier à chaque canal qui porte des conversations : Nodal chats en tête, puis l’ordre de la maquette', () => {
    // Quentin, 18/09 : « mets Nodal chats en premier avant Telegram ».
    const rows = folders({ channels: ['whatsapp', 'telegram', 'discord'] });
    expect(rows.map((r) => r.key)).toEqual([DASHBOARD_FOLDER, 'telegram', 'discord', 'whatsapp']);
  });

  it('n’invente pas de dossier pour un canal sans conversation', () => {
    const rows = folders({ channels: ['telegram'] });
    expect(rows.map((r) => r.key)).not.toContain('slack');
    expect(rows.map((r) => r.key)).not.toContain('discord');
  });

  it('montre quand même le dossier d’un canal qui porte une attente sans conversation lue', () => {
    // Sinon l'attente — et son compte — disparaîtraient du menu en silence.
    const rows = folders({ channels: [], waiting: waiting('slack') });
    expect(byKey(rows, 'slack').waiting).toBe(1);
  });

  it('garde « Nodal chats » même vide — c’est une destination, pas un contenu', () => {
    const rows = folders();
    expect(rows.map((r) => r.key)).toEqual([DASHBOARD_FOLDER]);
  });

  it('nomme et lie chaque dossier', () => {
    const rows = folders({ channels: ['telegram', 'whatsapp'] });
    expect(byKey(rows, 'telegram').label).toBe('Telegram');
    expect(byKey(rows, 'telegram').href).toBe('/chat?folder=telegram');
    // « WhatsApp », la casse du produit — pas « Whatsapp ».
    expect(byKey(rows, 'whatsapp').label).toBe('WhatsApp');
    expect(byKey(rows, DASHBOARD_FOLDER).label).toBe('Nodal chats');
    expect(byKey(rows, DASHBOARD_FOLDER).href).toBe('/chat?folder=dashboard');
    // Aucun dossier ne mène ailleurs que sur /chat : les routines ne sont pas là.
    expect(rows.every((r) => r.href.startsWith('/chat?folder='))).toBe(true);
  });
});

describe('le point vert, et ce qu’il ne compte pas @cap:reprendre-conversation/moteur', () => {
  it('s’allume là où un run tourne, et nulle part ailleurs', () => {
    const rows = folders({ channels: ['telegram', 'slack'], running: { telegram: 2 } });
    expect(byKey(rows, 'telegram').running).toBe(true);
    expect(byKey(rows, 'slack').running).toBe(false);
  });

  it('ne fait JAMAIS monter la pastille : un run n’attend pas la personne', () => {
    const rows = folders({ channels: ['telegram'], running: { telegram: 7 } });
    expect(byKey(rows, 'telegram').waiting).toBe(0);
    expect(byKey(rows, 'telegram').running).toBe(true);
  });

  it('reste éteint à zéro run', () => {
    const rows = folders({ channels: ['telegram'], running: { telegram: 0 } });
    expect(byKey(rows, 'telegram').running).toBe(false);
  });

  it('compte comme « en cours » tout statut vivant SAUF l’attente d’approbation', () => {
    // Le point dirait sinon la même chose que la pastille, sur les mêmes lignes.
    expect([...RUNNING_JOB_STATUSES]).toEqual(['pending', 'processing', 'awaiting_delegation']);
  });
});

describe('le dossier ouvert @cap:reprendre-conversation/moteur', () => {
  it('s’allume sur le `folder=` de l’URL', () => {
    const rows = folders({
      channels: ['telegram', 'slack'],
      pathname: '/chat',
      folderParam: 'telegram',
    });
    expect(byKey(rows, 'telegram').active).toBe(true);
    expect(byKey(rows, 'slack').active).toBe(false);
    expect(byKey(rows, DASHBOARD_FOLDER).active).toBe(false);
  });

  it('n’allume rien sur un fil ouvert — son URL ne dit pas d’où il vient', () => {
    const rows = folders({
      channels: ['telegram'],
      pathname: '/chat/6f1c0a42-0000-4000-8000-000000000000',
      folderParam: null,
    });
    expect(rows.every((r) => !r.active)).toBe(true);
  });

  it('n’allume AUCUN dossier sur la page des runs programmés : Scheduled a son propre lien', () => {
    // Quentin, 17/09 : « si je sélectionne Scheduled, ça sélectionne aussi
    // Routines, on ne sait plus où on est ».
    const rows = folders({ channels: ['telegram'], pathname: '/scheduled' });
    expect(rows.every((r) => !r.active)).toBe(true);
    expect(rows.map((r) => r.key)).not.toContain('routines');
  });
});

describe('le compte du lien « Chat » @cap:reprendre-conversation/moteur', () => {
  it('vaut exactement la somme des pastilles rendues en dessous', () => {
    const input = {
      channels: ['telegram', 'slack'],
      waiting: waiting('telegram', 'telegram', 'slack', 'dashboard', 'cron'),
      running: {},
      externalRuns: 0,
    };
    const rows = chatFolders({ ...input, pathname: '/chat', folderParam: null });
    const somme = rows.reduce((n, r) => n + r.waiting, 0);
    expect(chatWaitingTotal(input)).toBe(somme);
    // Quatre : telegram ×2, slack, dashboard. La demande `cron` n'a pas de
    // dossier ici, elle reste sur /approvals.
    expect(chatWaitingTotal(input)).toBe(4);
  });

  it('ne compte pas ce qui n’est dans aucun dossier', () => {
    expect(
      chatWaitingTotal({
        channels: ['telegram'],
        // `internal` seul ne dit d'où vient rien ; `api` dit « de dehors » et
        // compte donc, dans le dossier MCP.
        waiting: waiting('telegram', 'internal'),
        running: {},
        externalRuns: 0,
      }),
    ).toBe(1);
  });

  it('vaut zéro quand rien n’attend — le lien ne porte alors aucun chiffre', () => {
    expect(
      chatWaitingTotal({
        channels: ['telegram'],
        waiting: [],
        running: { telegram: 3 },
        externalRuns: 4,
      }),
    ).toBe(0);
  });
});

describe('le dossier MCP — ce qui arrive de dehors @cap:parler-par-canal-externe/moteur', () => {
  // Quentin, 18/09/2026. Un run lancé par `/api/agent` ou par le serveur MCP
  // n'a pas de conversation : personne ne lui parle. Il n'apparaissait qu'en
  // marge de /code, sous « Other sessions ». Il a son dossier, au même endroit
  // que les canaux — c'est bien un endroit d'où le travail arrive.
  //
  // Mutation vérifiée : `api` retiré de `MCP_JOB_CHANNELS` → « range un run de
  // l'API » rougit ; `externalRuns` ignoré dans `existingKeys` → « n'existe que
  // s'il y a un run » rougit dans les deux sens ; le canal de tête lu AVANT le
  // canal du job dans `folderOfWork` → « ne remonte pas la chaîne quand le job
  // se range lui-même » rougit.

  it('range un run de l’API et un run du serveur MCP dans le MÊME dossier', () => {
    expect(folderOfJobChannel('api')).toBe(MCP_FOLDER);
    expect(folderOfJobChannel('mcp')).toBe(MCP_FOLDER);
    const rows = folders({ externalRuns: 2, waiting: waiting('api', 'mcp') });
    expect(byKey(rows, MCP_FOLDER).waiting).toBe(2);
    // Et nulle part ailleurs : surtout pas dans « Nodal chats », le dossier qui
    // ramasserait tout si la règle se trompait.
    expect(byKey(rows, DASHBOARD_FOLDER).waiting).toBe(0);
  });

  it('compte la question d’un DÉLÉGUÉ de ce run, qui ne dit rien de lui-même', () => {
    // Un délégué porte `channel = 'internal'` et hérite du `conversation_id` de
    // son parent — donc rien, puisque le parent n'en a pas. Seul le canal de
    // TÊTE dit d'où la chaîne est partie.
    expect(
      folderOfWork({ jobChannel: 'internal', conversationChannel: null, rootChannel: 'mcp' }),
    ).toBe(MCP_FOLDER);
    const rows = folders({
      externalRuns: 1,
      waiting: [{ jobChannel: 'internal', conversationChannel: null, rootChannel: 'api' }],
    });
    expect(byKey(rows, MCP_FOLDER).waiting).toBe(1);
  });

  it('ne remonte PAS la chaîne quand le job se range déjà lui-même', () => {
    // Un délégué Telegram d'un run venu de dehors reste dans Telegram : son
    // propre canal a un dossier, et le canal de tête ne doit pas le déplacer.
    expect(
      folderOfWork({ jobChannel: 'telegram', conversationChannel: null, rootChannel: 'mcp' }),
    ).toBe('telegram');
    // Et la conversation passe toujours en premier, chaîne ou pas.
    expect(
      folderOfWork({ jobChannel: 'internal', conversationChannel: 'slack', rootChannel: 'mcp' }),
    ).toBe('slack');
  });

  it('ne range pas un travail de Telegram dans le dossier MCP', () => {
    const rows = folders({ channels: ['telegram'], externalRuns: 3, waiting: waiting('telegram') });
    expect(byKey(rows, 'telegram').waiting).toBe(1);
    expect(byKey(rows, MCP_FOLDER).waiting).toBe(0);
  });

  it('n’existe que si un run est venu de dehors', () => {
    expect(folders({ channels: ['telegram'] }).map((r) => r.key)).not.toContain(MCP_FOLDER);
    expect(folders({ externalRuns: 1 }).map((r) => r.key)).toContain(MCP_FOLDER);
  });

  it('n’existe PAS parce qu’une conversation porte ce canal — il tient à des RUNS', () => {
    // Sans quoi le dossier s'ouvrirait sur une liste vide : il liste des runs,
    // et une conversation `api` n'en est pas un.
    expect(folders({ channels: ['api'], externalRuns: 0 }).map((r) => r.key)).not.toContain(
      MCP_FOLDER,
    );
  });

  it('FERME la liste des dossiers, après les canaux', () => {
    const rows = folders({ channels: ['telegram', 'discord'], externalRuns: 1 });
    expect(rows.map((r) => r.key)).toEqual([DASHBOARD_FOLDER, 'telegram', 'discord', MCP_FOLDER]);
  });

  it('se nomme « MCP » et mène à sa propre vue', () => {
    const row = byKey(folders({ externalRuns: 1 }), MCP_FOLDER);
    expect(row.label).toBe('MCP');
    expect(row.href).toBe('/chat?folder=mcp');
  });

  it('allume son point vert quand un de ces runs tourne', () => {
    const rows = folders({ externalRuns: 2, running: { [MCP_FOLDER]: 1 } });
    expect(byKey(rows, MCP_FOLDER).running).toBe(true);
    expect(byKey(rows, MCP_FOLDER).waiting).toBe(0);
  });

  it('est actif quand l’URL le désigne, et lui seul', () => {
    const rows = folders({
      channels: ['telegram'],
      externalRuns: 1,
      pathname: '/chat',
      folderParam: MCP_FOLDER,
    });
    expect(byKey(rows, MCP_FOLDER).active).toBe(true);
    expect(byKey(rows, 'telegram').active).toBe(false);
  });
});

// ─── Les derniers fils d'un dossier (18/09/2026) ─────────────────────────────

/** Un fil de liste, réduit à ce que le sous-menu en montre. */
function fil(
  folder: string,
  n: number,
  etat: { waiting?: boolean; running?: boolean; unread?: boolean } = {},
): FolderThreadSource {
  return {
    folder,
    key: `${folder}-${n}`,
    title: `${folder} ${n}`,
    href: `/chat/${folder}-${n}`,
    waiting: etat.waiting ?? false,
    running: etat.running ?? false,
    unread: etat.unread ?? false,
  };
}

describe('folderThreads @cap:reprendre-conversation/ecran', () => {
  it('garde les ONZE premiers fils d’un dossier, et pas le douzième', () => {
    // ONZE, et pas dix : la lecture demande une ligne de plus que ce que le
    // menu dessine, et c'est sa présence qui dit qu'il y en a d'autres
    // (19/09/2026 au soir). La coupe à dix se fait à l'affichage,
    // `unfoldedRows`, qui rend aussi ce fait.
    const rows = Array.from({ length: 15 }, (_, i) => fil('telegram', i + 1));
    const dossiers = folderThreads(rows);
    expect(FOLDER_THREADS_MAX).toBe(10);
    expect(FOLDER_THREADS_PROBE).toBe(11);
    expect(dossiers.telegram).toHaveLength(11);

    const { rows: dessinees, hasMore } = unfoldedRows(dossiers.telegram ?? []);
    expect(dessinees.map((t) => t.title)).toEqual(
      Array.from({ length: 10 }, (_, i) => `telegram ${i + 1}`),
    );
    expect(hasMore).toBe(true);
  });

  it('ne promet PAS d’autres fils quand il n’y en a pas', () => {
    // Neuf fils, tous sous les yeux : « See all » mènerait aux mêmes neuf.
    const dossiers = folderThreads(Array.from({ length: 9 }, (_, i) => fil('telegram', i + 1)));
    const { rows, hasMore } = unfoldedRows(dossiers.telegram ?? []);
    expect(rows).toHaveLength(9);
    expect(hasMore).toBe(false);

    // Et à la limite EXACTE : dix lues, dix dessinées, rien de plus à voir.
    const pile = folderThreads(Array.from({ length: 10 }, (_, i) => fil('slack', i + 1)));
    expect(unfoldedRows(pile.slack ?? []).hasMore).toBe(false);
  });

  it('garde l’ORDRE de la liste, qui est celui de la lecture', () => {
    // Le plus récent d'abord. Un tri d'appoint ici ferait dire au sous-menu
    // autre chose que la liste que « See all » ouvre juste en dessous.
    const dossiers = folderThreads([fil('slack', 3), fil('slack', 1), fil('slack', 2)]);
    expect(dossiers.slack?.map((t) => t.key)).toEqual(['slack-3', 'slack-1', 'slack-2']);
  });

  it('range chaque fil sous SON dossier, même mêlés', () => {
    // Les lignes arrivent tous dossiers confondus : le dixième fil de
    // Telegram peut précéder le premier de Slack.
    const rows = [
      ...Array.from({ length: 14 }, (_, i) => fil('telegram', i + 1)),
      fil('slack', 1),
      fil(DASHBOARD_FOLDER, 1),
    ];
    const dossiers = folderThreads(rows);
    expect(dossiers.telegram).toHaveLength(11);
    expect(dossiers.slack?.map((t) => t.href)).toEqual(['/chat/slack-1']);
    expect(dossiers[DASHBOARD_FOLDER]).toHaveLength(1);
  });

  it('ne fabrique AUCUN dossier pour qui n’a pas de fil', () => {
    expect(folderThreads([])).toEqual({});
    expect(folderThreads([fil(MCP_FOLDER, 1)]).telegram).toBeUndefined();
  });

  it('transporte l’état de chaque fil, sans y toucher', () => {
    // Le point du sous-menu ne se recalcule pas ici : il lit ce que la lecture
    // a rangé sur le fil.
    const dossiers = folderThreads([
      fil('telegram', 1, { waiting: true }),
      fil('telegram', 2, { running: true }),
      fil('telegram', 3),
    ]);
    expect(dossiers.telegram?.map((t) => [t.waiting, t.running])).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ]);
  });
});

describe('threadCallsFor @cap:reprendre-conversation/ecran', () => {
  it('appelle la personne dès qu’une demande attend, ou qu’un run tourne', () => {
    expect(threadCallsFor({ waiting: true, running: false, unread: false })).toBe(true);
    expect(threadCallsFor({ waiting: false, running: true, unread: false })).toBe(true);
    expect(threadCallsFor({ waiting: true, running: true, unread: false })).toBe(true);
  });

  it('appelle la personne sur un fil NON LU, même au repos (#209)', () => {
    // Le troisième sens du point, et le seul qui ne demande rien : le fil a
    // bougé depuis qu'on l'a ouvert. Avant le 19/09/2026 la base ne portait
    // aucun état de lecture et ce cas ne pouvait pas exister.
    expect(threadCallsFor({ waiting: false, running: false, unread: true })).toBe(true);
  });

  it('se tait quand il n’y a ni demande, ni run, ni non-lu', () => {
    expect(threadCallsFor({ waiting: false, running: false, unread: false })).toBe(false);
  });
});

describe('threadDotTone @cap:reprendre-conversation/moteur', () => {
  it('garde le ROUGE pour ce qui attend une réponse, et pour cela seul', () => {
    // Décision du propriétaire, 22/09/2026. Le rouge réclame un geste ; un fil
    // non lu n'en réclame aucun, il y a seulement quelque chose à voir.
    //
    // Mutation vérifiée : `if (thread.waiting)` retiré → le premier cas rougit.
    expect(threadDotTone({ waiting: true, running: false, unread: false })).toBe('attention');
    expect(threadDotTone({ waiting: false, running: true, unread: false })).toBe('activite');
    expect(threadDotTone({ waiting: false, running: false, unread: true })).toBe('activite');
  });

  it('fait parler L’ATTENTE la première quand les deux sont vrais', () => {
    // Un fil à la fois en attente et non lu appelle d'abord pour ce qu'il
    // attend : c'est le seul des deux qui demande un geste.
    expect(threadDotTone({ waiting: true, running: true, unread: true })).toBe('attention');
    expect(threadDotTone({ waiting: true, running: false, unread: true })).toBe('attention');
  });

  it('se tait quand rien ne se passe', () => {
    expect(threadDotTone({ waiting: false, running: false, unread: false })).toBe('repos');
  });

  it('ne dit jamais autre chose que ce que `threadCallsFor` annonce', () => {
    // Les deux règles lisent les mêmes trois champs : un point qui appelle a
    // forcément une couleur qui se voit, et un point au repos n'en a aucune.
    for (const waiting of [false, true]) {
      for (const running of [false, true]) {
        for (const unread of [false, true]) {
          const fil = { waiting, running, unread };
          expect(threadDotTone(fil) === 'repos').toBe(!threadCallsFor(fil));
        }
      }
    }
  });
});
