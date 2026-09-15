// english.test.mjs — le portail est publié, et il se lit en ANGLAIS.
//
// Règle de Quentin, 14/09/2026 : « le portail qualité doit être 100 % en
// ANGLAIS ». Le dépôt est public. Les commentaires du code restent en français
// — c'est l'usage du dépôt et ils ne sont rendus nulle part ; ce qui S'AFFICHE,
// non.
//
// Une règle qu'aucune machine ne vérifie se perd au troisième contributeur : la
// prochaine carte ajoutée à `build.mjs` repartira en français, et personne ne
// s'en apercevra avant que la page soit publiée. D'où ce garde-fou.
//
// Il ne prétend pas détecter « du français » — aucune liste de mots ne sait
// faire ça. Il traque des MARQUEURS : des mots qui ne peuvent pas se trouver
// dans un texte anglais, et qui sont précisément ceux que ce lot a traduits.
// Chacun a été éprouvé par mutation : remettre le libellé français fait rougir.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { EXPLICATIONS } from './explications.mjs';
import { CAPACITES } from './capacites.mjs';
import { TITRE, corpsDeLalerte } from './alerte.mjs';

/**
 * Le source, commentaires RETIRÉS — même technique que `titresDeTest` dans
 * `lib.mjs`, et pour la même raison : les commentaires de ce dépôt sont en
 * français par choix, et les lire ferait rougir la garde en permanence.
 *
 * Un bloc `/* … *\/` ne compte que s'il COMMENCE une ligne (un `/*` en milieu
 * de ligne est presque toujours un glob dans une chaîne), et un `//` de même.
 */
function sansCommentaires(fichier) {
  return readFileSync(new URL(`./${fichier}`, import.meta.url), 'utf8')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Un texte rendu, débarrassé de ce qui n'est PAS de la prose : les `<code>`
 * (chemins, commandes, noms d'artefacts — `parcours-en-echec` en est un) et les
 * balises. Sans ça, la garde crierait sur `apps/qa/capacites.mjs`.
 */
const prose = (html) =>
  String(html ?? '')
    .replace(/<code>[\s\S]*?<\/code>/g, ' ')
    .replace(/<[^>]+>/g, ' ');

/** Tout ce que les explications et le registre font LIRE à quelqu'un. */
function textesRendus() {
  const out = [];
  for (const [id, x] of Object.entries(EXPLICATIONS)) {
    out.push([`${id}.titre`, x.titre], [`${id}.enBref`, x.enBref]);
    for (const p of x.parties) {
      out.push([`${id} › ${p.titre}`, p.titre], [`${id} › ${p.titre}`, p.texte]);
    }
    for (const [k, v] of Object.entries(x.blocs ?? {})) out.push([`${id}.blocs.${k}`, v]);
  }
  for (const c of CAPACITES) {
    out.push(
      [`${c.slug}.domaine`, c.domaine],
      [`${c.slug}.nom`, c.nom],
      [`${c.slug}.question`, c.question],
      [`${c.slug}.ecranAttendu`, c.ecranAttendu ?? ''],
      [`${c.slug}.preuveAttendue`, c.preuveAttendue ?? ''],
    );
  }
  out.push(['alerte.TITRE', TITRE]);
  out.push([
    'alerte.corps',
    corpsDeLalerte([{ titre: 'x', detail: 'y', quoi: ['a'] }], { le: '—', commit: 'c' }),
  ]);
  return out;
}

/**
 * Les marqueurs. Un mot par ligne, et chacun est un mot de PROSE française :
 * aucun n'est un identifiant du code, un slug, ou une classe CSS — c'est la
 * condition pour que la garde ne crie jamais à tort.
 */
const MARQUEURS = [
  'aucun',
  'aucune',
  'capacité',
  'chaque',
  'écran',
  'jamais',
  'moteur',
  'parcours',
  'preuve',
  'toujours',
  'qu’',
  "qu'",
  'pas de',
];

/**
 * Les marqueurs présents dans un texte, aux FRONTIÈRES de mot.
 *
 * Les frontières ne sont pas un détail : sans elles, `vueChantiers()` et
 * `trouverLeBillet()` — des identifiants, donc du code — faisaient rougir la
 * garde. Un contrôle qui crie sur du code finit désactivé.
 *
 * La casse compte par défaut, et c'est le même souci : `href="#chantiers"` est
 * une ANCRE, pas un libellé, et une comparaison insensible la prenait pour le
 * titre « Chantiers ». Seule la prose est cherchée sans la casse.
 *
 * La frontière n'est posée que du côté où le marqueur FINIT par une lettre.
 * Sans cette nuance, `qu'` — qui finit par une apostrophe — exigeait une
 * non-lettre après elle, c'est-à-dire l'inverse d'une élision : les deux
 * marqueurs les plus francophones de la liste ne trouvaient jamais rien
 * (revue Codex, 2e passe).
 */
const LETTRE = /\p{L}/u;
const dedans = (texte, mots, drapeaux = 'u') =>
  mots.filter((m) => {
    const echappe = m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const avant = LETTRE.test(m[0]) ? '(^|[^\\p{L}])' : '';
    const apres = LETTRE.test(m.at(-1)) ? '($|[^\\p{L}])' : '';
    return new RegExp(`${avant}${echappe}${apres}`, drapeaux).test(texte);
  });

const trouve = (texte) => dedans(texte, MARQUEURS, 'iu');

describe('le portail se lit en anglais', () => {
  it('aucune explication, aucune capacité, aucune alerte ne rend du français', () => {
    const fautifs = textesRendus()
      .map(([ou, texte]) => [ou, trouve(prose(texte))])
      .filter(([, mots]) => mots.length > 0)
      .map(([ou, mots]) => `${ou} : ${mots.join(', ')}`);
    expect(fautifs).toEqual([]);
  });

  it('les libellés de `build.mjs` sont en anglais — titres, colonnes, boutons', () => {
    // Le source hors commentaires. Les marqueurs sont ici des LIBELLÉS entiers,
    // pas des mots : `build.mjs` est du code, et « parcours » y est un nom de
    // variable parfaitement légitime.
    const src = sansCommentaires('build.mjs');
    const LIBELLES = [
      'Comprendre cette page',
      'Chantiers',
      'Capacités',
      'Écarts',
      'Mémoire des tests',
      'Banc d’essai',
      "Banc d'essai",
      'Déclencheurs',
      'Historique',
      'Comment ça tourne',
      'aucune description',
      'non mesuré',
      'voir le run',
      'À faire',
      'En cours',
      'En review',
      'À tester',
      'Abandonné',
      'décision',
      'sécurité',
      'Rien ici.',
    ];
    expect(dedans(src, LIBELLES)).toEqual([]);
  });

  it('les sorties console de la porte et du collecteur sont en anglais', () => {
    for (const f of ['porte.mjs', 'collect.mjs', 'serve.mjs', 'alerte.mjs']) {
      const src = sansCommentaires(f);
      const FAUTES = [
        'Capacités du produit',
        'exigées',
        'Le lien produit',
        'faute(s)',
        'Rien au rouge',
        'Billet',
        'Portail qualité',
        'introuvable',
        'lecture impossible',
        'sans réponse',
      ];
      expect(dedans(src, FAUTES), `${f} parle encore français`).toEqual([]);
    }
  });

  // La faute que ce lot a vraiment failli publier, et qu'aucun des contrôles
  // ci-dessus ne voyait : le code parle anglais, la COLLECTE COMMITTÉE parle
  // français. `docs.yml` publie sur push SANS collecter — le premier rendu
  // après le merge lit ce fichier-là. Les mots y sont des DONNÉES : la colonne
  // et les étiquettes d'une carte, la cadence d'un parcours, le nom d'un
  // workflow, le libellé d'une métrique du banc, le nom d'une capacité.
  it('la collecte committée porte le même vocabulaire que le code', () => {
    const s = JSON.parse(readFileSync(new URL('./data/snapshot.json', import.meta.url), 'utf8'));
    const textes = [];
    const dire = (ou, v) => v && textes.push([ou, String(v)]);

    for (const c of s.chantiers?.cartes ?? []) {
      dire(`carte #${c.numero}.colonne`, c.colonne);
      for (const e of c.etiquettes ?? []) dire(`carte #${c.numero}.etiquette`, e);
    }
    for (const p of s.parcours ?? []) dire(`${p.nom}.cadence`, p.cadence);
    for (const w of s.ci ?? []) {
      dire('workflow.nom', w.nom);
      for (const d of w.declencheurs ?? []) dire(`${w.fichier}.declencheur`, d);
    }
    for (const b of s.banc?.sections ?? []) {
      for (const m of b.metriques ?? []) {
        dire(`banc ${b.id}.label`, m.label);
        dire(`banc ${b.id}.unite`, m.unite ?? m.unit);
      }
    }
    for (const r of s.capacites?.registre ?? []) {
      dire(`${r.slug}.domaine`, r.domaine);
      dire(`${r.slug}.nom`, r.nom);
      dire(`${r.slug}.question`, r.question);
      dire(`${r.slug}.phrase`, r.phrase);
      dire(`${r.slug}.ecranAttendu`, r.ecranAttendu);
      dire(`${r.slug}.preuveAttendue`, r.preuveAttendue);
    }

    expect(textes.length).toBeGreaterThan(100);

    // Ici, et ICI SEULEMENT, un accent suffit à condamner : ces valeurs sont
    // des données de nomenclature — un nom de colonne, une étiquette, un
    // libellé de métrique — et aucune ne contient légitimement un accent.
    // La liste de marqueurs ne les attrapait pas : « Packages scannés » n'a
    // aucun mot français commun, et il s'affichait sur la page Banc (revue
    // Codex, 2e passe). Cette règle ne vaut pas pour la prose des
    // explications, où « façade » est un mot anglais parfaitement valide.
    const ACCENT = /[àâäçéèêëîïôöùûüÀÂÄÇÉÈÊËÎÏÔÖÙÛÜ]/;
    const fautifs = textes
      .map(([ou, t]) => [ou, [...trouve(t), ...(ACCENT.test(t) ? [`accent dans « ${t} »`] : [])]])
      .filter(([, mots]) => mots.length > 0)
      .map(([ou, mots]) => `${ou} : ${mots.join(', ')}`);
    expect(fautifs).toEqual([]);
  });
});
