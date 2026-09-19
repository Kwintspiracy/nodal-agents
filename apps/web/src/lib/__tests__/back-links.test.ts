// back-links.test.ts — « Back to … » ramène dans le bon dossier, déduit de la
// donnée (Quentin, 17/09 : un chat Discord doit revenir sur Discord).

import { describe, it, expect } from 'vitest';
import { threadBackLink, runBackLink } from '../back-links.ts';

describe('threadBackLink — un fil revient dans SON dossier', () => {
  it('un chat Discord revient sur le dossier Discord, pas sur la liste entière', () => {
    expect(threadBackLink('discord')).toEqual({
      label: 'Back to Discord',
      href: '/chat?folder=discord',
    });
    expect(threadBackLink('telegram')).toEqual({
      label: 'Back to Telegram',
      href: '/chat?folder=telegram',
    });
  });

  it('une conversation du dashboard revient sur « Nodal chats »', () => {
    expect(threadBackLink('dashboard')).toEqual({
      label: 'Back to Nodal chats',
      href: '/chat?folder=dashboard',
    });
  });

  it('un canal sans dossier revient à la liste entière', () => {
    expect(threadBackLink('webhook')).toEqual({ label: 'Back to channels', href: '/chat' });
    expect(threadBackLink('')).toEqual({ label: 'Back to channels', href: '/chat' });
  });

  it('un fil ANCRÉ à un projet revient au PROJET, pas à son canal', () => {
    // Quentin, 19/09 : une conversation ouverte depuis le workspace doit
    // revenir au workspace. Tous ses frères y sont listés ; « Nodal chats »
    // noyait le seul endroit où on la retrouve.
    expect(threadBackLink('dashboard', { id: 'p-1', name: 'Nodal Agents' })).toEqual({
      label: 'Back to Nodal Agents',
      href: '/spaces/p-1',
    });
    // Même pour un fil de canal : le projet passe devant le dossier.
    expect(threadBackLink('telegram', { id: 'p-1', name: 'Nodal Agents' })).toEqual({
      label: 'Back to Nodal Agents',
      href: '/spaces/p-1',
    });
  });

  it('sans projet, rien ne change : le dossier du canal reprend la main', () => {
    expect(threadBackLink('discord', null)).toEqual({
      label: 'Back to Discord',
      href: '/chat?folder=discord',
    });
    expect(threadBackLink('dashboard', undefined)).toEqual({
      label: 'Back to Nodal chats',
      href: '/chat?folder=dashboard',
    });
  });

  it('un FIL ne revient jamais dans le dossier MCP : il n’y liste que des runs', () => {
    // Le dossier existe pour `api` et `mcp` côté RUN (18/09), mais il ne montre
    // aucune conversation : y renvoyer un fil le déposerait sur une liste où il
    // ne figure pas.
    expect(threadBackLink('api')).toEqual({ label: 'Back to channels', href: '/chat' });
    expect(threadBackLink('mcp')).toEqual({ label: 'Back to channels', href: '/chat' });
  });
});

describe('runBackLink — un run revient là d’où on l’ouvre', () => {
  it('le run d’une automatisation revient à SON automatisation, même s’il a une conversation', () => {
    // Quentin, 19/09 : « le bouton back me ramène à la page Scheduled, qui est
    // censée ne plus exister ». Il ramène à l'automatisation, où ce run est
    // justement listé.
    expect(runBackLink({ channel: 'cron', conversationId: 'c1', scheduleId: 's1' })).toEqual({
      label: 'Back to the automation',
      href: '/automations/s1',
    });
  });

  it('un run de cron trop ancien pour porter cet id revient à la LISTE', () => {
    // Les jobs d'avant cette provenance n'ont pas d'id d'automatisation. On ne
    // devine pas laquelle c'était : on ramène à la liste, jamais à une page
    // d'automatisation choisie au hasard (invariant #4).
    expect(runBackLink({ channel: 'cron', conversationId: null, scheduleId: null })).toEqual({
      label: 'Back to Automations',
      href: '/automations',
    });
    expect(runBackLink({ channel: 'cron', conversationId: null })).toEqual({
      label: 'Back to Automations',
      href: '/automations',
    });
  });

  it('ne ramène JAMAIS à /scheduled, la page retirée', () => {
    for (const job of [
      { channel: 'cron', conversationId: 'c1', scheduleId: 's1' },
      { channel: 'cron', conversationId: null },
      { channel: 'telegram', conversationId: 'c1' },
      { channel: 'dashboard', conversationId: '' },
    ]) {
      expect(runBackLink(job).href).not.toBe('/scheduled');
    }
  });

  it('le run d’une conversation revient à cette conversation', () => {
    expect(runBackLink({ channel: 'telegram', conversationId: 'c1' })).toEqual({
      label: 'Back to the conversation',
      href: '/chat/c1',
    });
  });

  it('un run venu de dehors revient dans le dossier MCP, d’où on vient de le lister', () => {
    expect(runBackLink({ channel: 'api', conversationId: null })).toEqual({
      label: 'Back to MCP',
      href: '/chat?folder=mcp',
    });
    expect(runBackLink({ channel: 'mcp', conversationId: '' })).toEqual({
      label: 'Back to MCP',
      href: '/chat?folder=mcp',
    });
  });

  it('un job `api` QUI PORTE UN FIL revient au fil : c’est un tour de chat', () => {
    // Le même canal sert la boîte « Send task » et un tour de chat : ce qui les
    // sépare est la conversation, et elle passe avant le dossier.
    expect(runBackLink({ channel: 'api', conversationId: 'c9' })).toEqual({
      label: 'Back to the conversation',
      href: '/chat/c9',
    });
  });

  it('un run sans conversation et sans dossier revient à Activity', () => {
    expect(runBackLink({ channel: 'dashboard', conversationId: '' })).toEqual({
      label: 'Back to Activity',
      href: '/logs',
    });
    expect(runBackLink({ channel: 'webhook', conversationId: null })).toEqual({
      label: 'Back to Activity',
      href: '/logs',
    });
  });
});
