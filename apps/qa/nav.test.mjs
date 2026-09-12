// nav.test.mjs — la barre de gauche ne montre que ce qui se pilote.
// Décision produit du 12/09/2026 : cinq pages de pilotage en haut, dans
// l'ordre où on les regarde, puis la rubrique « Comment ça tourne » qui
// regroupe les quatre pages de plomberie qu'on lit une fois par mois.
// L'ordre est un choix, pas un hasard : on le fige ici sinon la prochaine
// page ajoutée se pose au hasard et la barre redevient une liste à plat.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const build = readFileSync(new URL('./build.mjs', import.meta.url), 'utf8');

const bloc = build.match(/<nav id="nav">([\s\S]*?)<\/nav>/);

/** Les entrées de la barre, dans l'ordre du source : liens et intitulé de rubrique. */
const entrees = [...(bloc?.[1] ?? '').matchAll(/<(a|p)\s([^>]*)>([^<$]*)/g)]
  .map((m) => ({
    genre: m[1] === 'a' ? 'lien' : 'rubrique',
    ancre: (m[2].match(/href="#([a-z]+)"/) ?? [null, null])[1],
    libelle: m[3].trim().replace(/\s+/g, ' '),
  }))
  .filter((e) => e.libelle.length > 0);

describe('la barre de gauche', () => {
  it('sépare les cinq pages de pilotage de la plomberie, dans cet ordre', () => {
    expect(entrees).toEqual([
      { genre: 'lien', ancre: 'chantiers', libelle: 'Chantiers' },
      { genre: 'lien', ancre: 'capacites', libelle: 'Capacités' },
      { genre: 'lien', ancre: 'ecarts', libelle: 'Écarts' },
      { genre: 'lien', ancre: 'parcours', libelle: 'Parcours' },
      { genre: 'lien', ancre: 'memoire', libelle: 'Mémoire des tests' },
      { genre: 'rubrique', ancre: null, libelle: 'Comment ça tourne' },
      { genre: 'lien', ancre: 'vue', libelle: "Tests, vue d'ensemble" },
      { genre: 'lien', ancre: 'banc', libelle: "Banc d'essai" },
      { genre: 'lien', ancre: 'ci', libelle: 'Déclencheurs' },
      { genre: 'lien', ancre: 'historique', libelle: 'Historique' },
    ]);
  });

  it('les quatre pages de plomberie sont les seules en retrait', () => {
    const discrets = [
      ...(bloc?.[1] ?? '').matchAll(/<a[^>]*href="#([a-z]+)"[^>]*class="[^"]*discret[^"]*"/g),
    ].map((m) => m[1]);
    expect(discrets).toEqual(['vue', 'banc', 'ci', 'historique']);
  });

  it('chaque lien de la barre vise une page rendue — pas d’ancre morte', () => {
    const rendues = new Set(
      [...build.matchAll(/<section id="([a-z]+)" class="vue/g)].map((m) => m[1]),
    );
    for (const e of entrees.filter((e) => e.genre === 'lien')) {
      expect(rendues.has(e.ancre), `#${e.ancre} n’est rendue nulle part`).toBe(true);
    }
    expect(entrees.filter((e) => e.genre === 'lien').length).toBe(rendues.size);
  });
});
