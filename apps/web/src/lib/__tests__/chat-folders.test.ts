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
  folderOfJobChannel,
  DASHBOARD_FOLDER,
  RUNNING_JOB_STATUSES,
} from '../chat-folders.ts';

/** Une attente, réduite à ce que l'attribution lit. */
function waiting(...channels: (string | null)[]): { jobChannel: string | null }[] {
  return channels.map((jobChannel) => ({ jobChannel }));
}

function folders(input: Partial<Parameters<typeof chatFolders>[0]> = {}) {
  return chatFolders({
    channels: [],
    waiting: [],
    running: {},
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
    // `api` = la boîte « New task », `internal` = un agent qui appelle un agent,
    // `null` = un job disparu sous la jointure. Aucun n'est un dossier de chat.
    expect(folderOfJobChannel('api')).toBeNull();
    expect(folderOfJobChannel('internal')).toBeNull();
    expect(folderOfJobChannel('mcp')).toBeNull();
    expect(folderOfJobChannel(null)).toBeNull();
    const rows = folders({ channels: ['telegram'], waiting: waiting('api', 'internal', null) });
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
        waiting: waiting('telegram', 'api', 'internal'),
        running: {},
      }),
    ).toBe(1);
  });

  it('vaut zéro quand rien n’attend — le lien ne porte alors aucun chiffre', () => {
    expect(
      chatWaitingTotal({ channels: ['telegram'], waiting: [], running: { telegram: 3 } }),
    ).toBe(0);
  });
});
