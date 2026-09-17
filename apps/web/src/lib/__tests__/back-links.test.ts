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
    expect(threadBackLink('api')).toEqual({ label: 'Back to channels', href: '/chat' });
    expect(threadBackLink('')).toEqual({ label: 'Back to channels', href: '/chat' });
  });
});

describe('runBackLink — un run revient là d’où on l’ouvre', () => {
  it('une automation revient aux routines, même si elle a une conversation', () => {
    expect(runBackLink({ channel: 'cron', conversationId: 'c1' })).toEqual({
      label: 'Back to Routines',
      href: '/scheduled',
    });
  });

  it('le run d’une conversation revient à cette conversation', () => {
    expect(runBackLink({ channel: 'telegram', conversationId: 'c1' })).toEqual({
      label: 'Back to the conversation',
      href: '/chat/c1',
    });
  });

  it('un run sans conversation revient à Activity', () => {
    expect(runBackLink({ channel: 'api', conversationId: null })).toEqual({
      label: 'Back to Activity',
      href: '/logs',
    });
    expect(runBackLink({ channel: 'dashboard', conversationId: '' })).toEqual({
      label: 'Back to Activity',
      href: '/logs',
    });
  });
});
