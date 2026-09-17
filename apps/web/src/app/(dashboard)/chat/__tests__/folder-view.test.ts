// folder-view.test.ts — ce que `/chat?folder=…` montre, et ce qu'il en dit.
//
// Deux choses s'y prouvent, et elles se répondent : un dossier ne montre QUE
// ce qui lui appartient, et sa phrase ne dit QUE des chiffres non nuls. Un
// dossier qui montrerait tout, ou une phrase qui dirait « 0 waiting for you »,
// rendraient le menu inutile — c'était le point de départ (#135).

import { describe, it, expect } from 'vitest';
import { chatFolderView, folderSubtitle } from '../folder-view.ts';

const CHANNELS = ['telegram', 'slack'];

describe('la vue d’un dossier @cap:reprendre-conversation/moteur', () => {
  it('sans `folder=`, montre TOUT, sous le titre de la page', () => {
    const v = chatFolderView(null, CHANNELS);
    expect(v.key).toBeNull();
    expect(v.title).toBe('Channels');
    expect(v.showChannels).toBe(true);
    expect(v.showDashboard).toBe(true);
    expect(v.channel).toBeNull();
  });

  it('sur un canal, ne montre QUE ce canal — pas les conversations de Nodal', () => {
    const v = chatFolderView('telegram', CHANNELS);
    expect(v.key).toBe('telegram');
    expect(v.title).toBe('Telegram');
    expect(v.channel).toBe('telegram');
    expect(v.showChannels).toBe(true);
    expect(v.showDashboard).toBe(false);
  });

  it('sur « Nodal chats », ne montre QUE les conversations de Nodal', () => {
    const v = chatFolderView('dashboard', CHANNELS);
    expect(v.title).toBe('Nodal chats');
    expect(v.showChannels).toBe(false);
    expect(v.showDashboard).toBe(true);
    expect(v.channel).toBeNull();
  });

  it('sur un canal que la base ne connaît pas, redevient la page entière', () => {
    // `?folder=nimportequoi` donnait sinon une page vide intitulée
    // « Nimportequoi » — un dossier vide là où il n'y a pas de dossier.
    const v = chatFolderView('nimportequoi', CHANNELS);
    expect(v.key).toBeNull();
    expect(v.title).toBe('Channels');
    expect(v.showChannels).toBe(true);
    expect(v.showDashboard).toBe(true);
  });

  it('sur un dossier que le menu ne propose pas, redevient la page entière', () => {
    const v = chatFolderView('routines', CHANNELS);
    expect(v.key).toBeNull();
    expect(v.title).toBe('Channels');
  });
});

describe('la phrase sous le titre d’un dossier @cap:reprendre-conversation/moteur', () => {
  it('dit les trois chiffres quand les trois existent', () => {
    expect(folderSubtitle({ conversations: 3, waiting: 1, running: 2 })).toBe(
      '3 conversations · 1 waiting for you · 2 running',
    );
  });

  it('accorde « conversation » au singulier', () => {
    expect(folderSubtitle({ conversations: 1, waiting: 0, running: 0 })).toBe('1 conversation');
  });

  it('TAIT chaque chiffre nul plutôt que d’écrire zéro', () => {
    expect(folderSubtitle({ conversations: 4, waiting: 0, running: 1 })).toBe(
      '4 conversations · 1 running',
    );
    expect(folderSubtitle({ conversations: 0, waiting: 2, running: 0 })).toBe('2 waiting for you');
  });

  it('ne dit RIEN quand tout est à zéro', () => {
    expect(folderSubtitle({ conversations: 0, waiting: 0, running: 0 })).toBeNull();
  });
});
