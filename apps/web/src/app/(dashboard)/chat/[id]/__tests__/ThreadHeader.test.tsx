// ThreadHeader.test.tsx — l'en-tête des trois écrans de fil (#135).
//
// Ce que le test tient : l'en-tête dit QUI et DE QUOI sur une ligne, d'où et
// depuis quand sur l'autre, et il ne dessine pas ce qu'il ne sait pas — un fil
// dont la date d'ouverture manque n'écrit pas « started — ».

import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ThreadHeader from '../ThreadHeader.tsx';
import { startedLabel, threadSubtitle } from '@/app/(dashboard)/spaces/format.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('startedLabel — depuis quand le fil est ouvert', () => {
  it('dit « today » le jour même, et « yesterday » la veille — sur le CALENDRIER, pas sur 24 h', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 17, 0, 10));
    // Ouvert à 23 h 50 la veille : dix minutes plus tôt, et pourtant hier.
    expect(startedLabel(new Date(2026, 8, 16, 23, 50))).toBe('started yesterday 23:50');
    expect(startedLabel(new Date(2026, 8, 17, 0, 5))).toBe('started today 00:05');
  });

  it('au-delà, une date brève — jamais « 2 days ago » dans un en-tête', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 17, 14, 1));
    const label = startedLabel(new Date(2026, 8, 12, 9, 30));
    expect(label).toMatch(/^started \S+ 12 09:30$/);
    expect(label).not.toContain('today');
    expect(label).not.toContain('yesterday');
  });

  it('sans date, RIEN — et le sous-titre se réduit à la provenance', () => {
    expect(startedLabel(null)).toBeNull();
    expect(threadSubtitle('via Telegram', null)).toBe('via Telegram');
  });

  it('le sous-titre garde les MOTS de la provenance, et lui accole l’ouverture', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 17, 18, 0));
    expect(threadSubtitle('via Telegram', new Date(2026, 8, 17, 14, 1))).toBe(
      'via Telegram · started today 14:01',
    );
    expect(threadSubtitle('from the dashboard', new Date(2026, 8, 17, 14, 1))).toBe(
      'from the dashboard · started today 14:01',
    );
  });

  it('un fil d’une autre année dit son année ; celui de cette année ne la répète pas', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 17, 18, 0));
    const vieux = startedLabel(new Date(2025, 8, 12, 9, 30));
    expect(vieux).toContain('2025');
    expect(vieux).toMatch(/09:30$/);
    // Cette année : « Sep 12 », sans l'année, comme la planche.
    expect(startedLabel(new Date(2026, 8, 12, 9, 30))).not.toContain('2026');
  });
});

describe('ThreadHeader — ce que l’en-tête dessine', () => {
  it('l’avatar, le titre et le sous-titre, aux styles de la maquette', () => {
    const html = renderToStaticMarkup(
      <ThreadHeader
        avatarName="Marlowe"
        title="Marlowe · HTML map of the shops around the office"
        subtitle="via Telegram · started today 14:01"
      />,
    );
    expect(html).toContain('Marlowe · HTML map of the shops around the office');
    expect(html).toContain('via Telegram · started today 14:01');
    // Les initiales, faute d'image.
    expect(html).toContain('MA');
    // Title/16 pour le titre, Mono/11 pour le sous-titre — les utilitaires de
    // l'échelle, jamais une taille en pixels.
    // Le titre de la page est un h1 : le mode `header` retire celui du DS, et
    // un écran de fil ne peut pas rester sans nom (parcours de fumée #135).
    expect(html).toMatch(/<h1 class="[^"]*text-title-16[^"]*"[^>]*>Marlowe ·/);
    expect(html).toMatch(/class="[^"]*text-mono-11[^"]*"[^>]*>via Telegram/);
    expect(html).not.toMatch(/text-\[\d/);
  });

  it('sans nom d’agent, pas de portrait — jamais un « ? »', () => {
    const html = renderToStaticMarkup(
      <ThreadHeader avatarName="" title="HTML map of the shops" subtitle="via Telegram" />,
    );
    expect(html).toContain('HTML map of the shops');
    expect(html).not.toContain('>?<');
  });

  it('l’image de l’agent REMPLACE les initiales quand il en a une', () => {
    const html = renderToStaticMarkup(
      <ThreadHeader
        avatarName="Vega Orin"
        avatarUrl="/avatars/vega.png"
        title="Vega Orin · nightly digest"
        subtitle="run · started yesterday 09:30"
      />,
    );
    expect(html).toContain('<img');
    expect(html).toContain('vega.png');
    expect(html).not.toContain('>VO<');
  });
});
