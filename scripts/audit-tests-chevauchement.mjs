#!/usr/bin/env node
// audit-tests-chevauchement.mjs — trouve les cas de test qui se recouvrent au
// point de coûter du temps de CI sans ajouter de protection.
//
// Le dépôt porte ~7 000 cas pour 587 fichiers. La pratique depuis juillet 2026
// est d'AJOUTER un test nommé d'après chaque défaut trouvé en revue, et de ne
// presque jamais fusionner ni supprimer. L'hypothèse qu'on vérifie ici : une
// part de ces cas exercent la même branche de code avec la même forme
// d'assertion, à une valeur près.
//
// Ce qui est cherché — et RIEN d'autre :
//   deux cas tels que l'un ne peut pas tomber sans que l'autre tombe aussi,
//   pour la même raison. Mêmes appels, mêmes formes d'assertions, même branche.
//
// Ce qui n'est PAS un chevauchement :
//   - un test unitaire et un test e2e sur la même ligne — c'est de la défense
//     en profondeur, et les deux tombent pour des raisons différentes ;
//   - un test nommé d'après un incident réel qui recoupe un test générique
//     MAIS exerce une entrée différente — il documente le cas, et le rapport
//     le signale comme tel plutôt que de le proposer à la suppression.
//
// Détection, en deux niveaux, du plus sûr au plus douteux :
//   (a) CERTAINS  — corps identiques après normalisation (commentaires et
//       espaces retirés, littéraux remplacés par des jetons). Deux cas qui ne
//       diffèrent que par leurs valeurs d'entrée : la fusion est un
//       `test.each`, mécanique et sans perte.
//       Sous-cas signalé à part : les littéraux sont identiques EUX AUSSI —
//       c'est une copie pure, supprimable sans rien écrire.
//   (b) PROBABLES — même suite d'appels et même suite de matchers `expect`,
//       avec au plus UN littéral différent, mais des corps qui ne sont pas
//       identiques. À relire un par un : la différence restante est soit du
//       bruit, soit toute la valeur du test.
//
// Le coût ne se lit pas dans la source. Il vient de `apps/qa/data/tests.ndjson`,
// la mémoire test par test du portail qualité, alimentée par le
// `--reporter=json` de la CI (voir `.github/workflows/qa.yml`). Chaque entrée y
// porte un `dureeMs`. Le coût d'un groupe = la somme des durées de tous ses
// membres SAUF UN : c'est ce qu'on économiserait, pas ce que le groupe coûte.
//
// Usage :
//   node scripts/audit-tests-chevauchement.mjs                  # rapport sur stdout
//   node scripts/audit-tests-chevauchement.mjs --out <fichier>  # rapport Markdown
//   node scripts/audit-tests-chevauchement.mjs --json <fichier> # données brutes
//
// Ce script ne MODIFIE aucun test. Il produit un rapport, et c'est tout.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = fileURLToPath(new URL('..', import.meta.url));

/** Dossiers qu'on ne descend jamais. `.claude` porte des copies périmées de
 * l'arbre — le `vitest.config.ts` racine l'exclut pour la même raison. */
const IGNORES = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  '.claude',
  '.git',
  'coverage',
  'playwright-report',
  'test-results',
]);

/** Un fichier de test, au sens où vitest ou playwright le ramasse. */
const EST_TEST = /\.(test|spec|pg\.test)\.(ts|tsx|mts|js|mjs|cjs)$/;

// ───────────────────────────── 1. Parcours ──────────────────────────────────

function listerFichiersTest(racine) {
  const trouves = [];
  const pile = [racine];
  while (pile.length > 0) {
    const dossier = pile.pop();
    let entrees;
    try {
      entrees = readdirSync(dossier, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entree of entrees) {
      if (entree.name.startsWith('.') && entree.name !== '.github') {
        if (IGNORES.has(entree.name)) continue;
      }
      if (IGNORES.has(entree.name)) continue;
      const chemin = join(dossier, entree.name);
      if (entree.isDirectory()) {
        pile.push(chemin);
      } else if (EST_TEST.test(entree.name)) {
        trouves.push(chemin);
      }
    }
  }
  return trouves.sort();
}

// ──────────────────────── 2. Découpage lexical ──────────────────────────────
//
// On ne charge pas le compilateur TypeScript : il faudrait le lancer sur 587
// fichiers, et on n'a besoin que d'une chose — savoir où commence et où finit
// le corps d'un `it(...)`. Ce que ça demande, c'est de ne pas se faire piéger
// par une PARENTHÈSE — c'est elle qui délimite l'appel, pas l'accolade — cachée
// dans une chaîne, un commentaire ou une expression régulière. D'où ce scanner
// à états, qui produit pour chaque caractère du fichier son « genre » : code,
// chaîne, commentaire.

const CODE = 0;
const CHAINE = 1;
const COMMENTAIRE = 2;

/**
 * Classe chaque caractère du source. Retourne un Uint8Array parallèle à la
 * source : CODE, CHAINE ou COMMENTAIRE. Les délimiteurs (guillemets, `/*`)
 * comptent pour leur zone.
 *
 * Le seul cas réellement ambigu en JS est le `/` : division ou début
 * d'expression régulière ? On tranche sur le dernier caractère significatif,
 * l'heuristique habituelle — après un identifiant, un nombre ou une
 * parenthèse fermante c'est une division, sinon c'est une regex. Un faux
 * classement ici ne casse rien de grave : il déplace au pire une frontière de
 * corps, et le cas ne sera pas apparié.
 */
function classer(src) {
  const genres = new Uint8Array(src.length);
  let i = 0;
  let dernierSignificatif = '';
  // Pile des interpolations `${...}` d'un littéral gabarit : chaque entrée
  // mémorise la profondeur d'accolades à laquelle on retombe dans la chaîne.
  const gabarits = [];
  let profondeurAccolades = 0;

  while (i < src.length) {
    const c = src[i];
    const suivant = src[i + 1];

    // — commentaires —
    if (c === '/' && suivant === '/') {
      while (i < src.length && src[i] !== '\n') genres[i++] = COMMENTAIRE;
      continue;
    }
    if (c === '/' && suivant === '*') {
      genres[i++] = COMMENTAIRE;
      genres[i++] = COMMENTAIRE;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) genres[i++] = COMMENTAIRE;
      if (i < src.length) {
        genres[i++] = COMMENTAIRE;
        genres[i++] = COMMENTAIRE;
      }
      continue;
    }

    // — chaînes simples et doubles —
    if (c === "'" || c === '"') {
      const ouvrant = c;
      genres[i++] = CHAINE;
      while (i < src.length) {
        if (src[i] === '\\') {
          genres[i++] = CHAINE;
          if (i < src.length) genres[i++] = CHAINE;
          continue;
        }
        if (src[i] === ouvrant) {
          genres[i++] = CHAINE;
          break;
        }
        if (src[i] === '\n') break; // chaîne non terminée : on ne s'entête pas
        genres[i++] = CHAINE;
      }
      dernierSignificatif = ouvrant;
      continue;
    }

    // — littéraux gabarits —
    if (c === '`') {
      genres[i++] = CHAINE;
      while (i < src.length) {
        if (src[i] === '\\') {
          genres[i++] = CHAINE;
          if (i < src.length) genres[i++] = CHAINE;
          continue;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          genres[i++] = CHAINE;
          genres[i++] = CHAINE;
          gabarits.push(profondeurAccolades);
          profondeurAccolades++;
          break; // on repasse en CODE dans l'interpolation
        }
        if (src[i] === '`') {
          genres[i++] = CHAINE;
          break;
        }
        genres[i++] = CHAINE;
      }
      dernierSignificatif = '`';
      continue;
    }

    // — expressions régulières —
    if (c === '/' && !/[\w)\]$]/.test(dernierSignificatif)) {
      const depart = i;
      let j = i + 1;
      let classe = false;
      let fermee = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '[') classe = true;
        else if (src[j] === ']') classe = false;
        else if (src[j] === '/' && !classe) {
          fermee = true;
          j++;
          break;
        }
        j++;
      }
      if (fermee) {
        while (j < src.length && /[a-z]/.test(src[j])) j++;
        // Une regex est un littéral : on la range avec les chaînes, elle sera
        // remplacée par un jeton comme les autres.
        for (let k = depart; k < j; k++) genres[k] = CHAINE;
        i = j;
        dernierSignificatif = '/';
        continue;
      }
    }

    // — code ordinaire —
    genres[i] = CODE;
    if (c === '{') profondeurAccolades++;
    else if (c === '}') {
      profondeurAccolades--;
      // Fin d'une interpolation : on retourne dans le gabarit.
      if (gabarits.length > 0 && gabarits[gabarits.length - 1] === profondeurAccolades) {
        gabarits.pop();
        genres[i++] = CHAINE;
        while (i < src.length) {
          if (src[i] === '\\') {
            genres[i++] = CHAINE;
            if (i < src.length) genres[i++] = CHAINE;
            continue;
          }
          if (src[i] === '$' && src[i + 1] === '{') {
            genres[i++] = CHAINE;
            genres[i++] = CHAINE;
            gabarits.push(profondeurAccolades);
            profondeurAccolades++;
            break;
          }
          if (src[i] === '`') {
            genres[i++] = CHAINE;
            break;
          }
          genres[i++] = CHAINE;
        }
        continue;
      }
    }
    if (!/\s/.test(c)) dernierSignificatif = c;
    i++;
  }
  return genres;
}

// ───────────────────── 3. Extraction des cas de test ────────────────────────

/**
 * Trouve la parenthèse fermante correspondant à `ouvrante`, en ne comptant que
 * les parenthèses classées CODE.
 */
function fermerParenthese(src, genres, ouvrante) {
  let profondeur = 0;
  for (let i = ouvrante; i < src.length; i++) {
    if (genres[i] !== CODE) continue;
    if (src[i] === '(') profondeur++;
    else if (src[i] === ')') {
      profondeur--;
      if (profondeur === 0) return i;
    }
  }
  return -1;
}

/** Numéro de ligne (1-indexé) d'un décalage. */
function ligneDe(src, decalage) {
  let ligne = 1;
  for (let i = 0; i < decalage && i < src.length; i++) if (src[i] === '\n') ligne++;
  return ligne;
}

/**
 * Extrait les littéraux chaîne d'un extrait, dans l'ordre, en s'appuyant sur
 * la classification. Retourne leur contenu brut, délimiteurs compris.
 */
function litteraux(src, genres, debut, fin) {
  const sortie = [];
  let i = debut;
  while (i < fin) {
    if (genres[i] === CHAINE) {
      const depart = i;
      while (i < fin && genres[i] === CHAINE) i++;
      sortie.push(src.slice(depart, i));
    } else {
      i++;
    }
  }
  return sortie;
}

/**
 * Le corps normalisé : commentaires supprimés, littéraux (chaînes, gabarits,
 * regex) remplacés par le jeton `§`, nombres par `#`, espaces écrasés. Les
 * identifiants sont CONSERVÉS — c'est eux qui portent la branche de code
 * exercée, et les effacer ferait se ressembler deux tests qui n'appellent pas
 * la même fonction.
 */
function normaliser(src, genres, debut, fin) {
  let out = '';
  let i = debut;
  while (i < fin) {
    if (genres[i] === COMMENTAIRE) {
      i++;
      continue;
    }
    if (genres[i] === CHAINE) {
      while (i < fin && genres[i] === CHAINE) i++;
      out += '§';
      continue;
    }
    out += src[i];
    i++;
  }
  return out
    .replace(/\b\d[\d_.eE+-]*\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Les noms de fonctions appelées dans un extrait, dans l'ordre, sans doublons
 * consécutifs. Sert à la détection (b) et à la lecture du rapport. */
function appelsDe(normalise) {
  const noms = [];
  const motif = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g;
  let m;
  while ((m = motif.exec(normalise)) !== null) {
    const nom = m[1];
    if (nom === 'if' || nom === 'for' || nom === 'while' || nom === 'switch' || nom === 'catch')
      continue;
    noms.push(nom);
  }
  return noms;
}

/** Les matchers d'assertion, dans l'ordre : `expect(...).toBe`, `.rejects.toThrow`… */
function assertionsDe(normalise) {
  const formes = [];
  const motif = /\bexpect(?:\.\w+)?\s*\(/g;
  let m;
  while ((m = motif.exec(normalise)) !== null) {
    // On lit ce qui suit la parenthèse fermante de l'expect pour récupérer la
    // chaîne de matchers, sans repasser par un parseur : on avance en comptant
    // les parenthèses sur le texte NORMALISÉ (les littéraux y sont déjà des
    // jetons, donc aucune parenthèse parasite).
    let profondeur = 0;
    let i = m.index + m[0].length - 1;
    for (; i < normalise.length; i++) {
      if (normalise[i] === '(') profondeur++;
      else if (normalise[i] === ')') {
        profondeur--;
        if (profondeur === 0) break;
      }
    }
    const queue = normalise.slice(i + 1, i + 80);
    const matcher = queue.match(/^((?:\s*\.\s*\w+)+)/);
    formes.push(matcher ? matcher[1].replace(/\s+/g, '') : '(sans matcher)');
  }
  return formes;
}

/**
 * Lit un fichier et en sort la liste de ses cas de test.
 *
 * Le titre d'un cas est le premier littéral chaîne de l'appel. Pour un
 * `it.each([...])('titre %s', …)` le premier littéral se trouve dans le
 * tableau : on prend alors le premier littéral situé APRÈS la dernière
 * parenthèse fermante de la chaîne d'appel, ce que gère `depuis`.
 */
function extraireCas(chemin) {
  return analyserSource(
    readFileSync(chemin, 'utf8'),
    relative(RACINE, chemin).split(sep).join('/'),
  );
}

/** Le cœur de l'extraction, sur une source en mémoire — c'est cette forme que
 * les tests exercent, sans passer par le disque. */
export function analyserSource(src, relatif) {
  const genres = classer(src);
  const cas = [];

  // Pile des `describe` ouverts, pour reconstruire le titre complet — c'est
  // sous cette forme que la mémoire du portail range les durées.
  const describes = [];

  const motif = /\b(describe|it|test)(\s*\.\s*\w+(\s*\([^)]*\))?)*\s*\(/g;
  let m;
  while ((m = motif.exec(src)) !== null) {
    const debutMot = m.index;
    if (genres[debutMot] !== CODE) continue;
    // `foo.it(` n'est pas une déclaration de cas.
    const avant = src.slice(Math.max(0, debutMot - 1), debutMot);
    if (/[\w$.]/.test(avant)) continue;

    const ouvrante = m.index + m[0].length - 1;
    const fermante = fermerParenthese(src, genres, ouvrante);
    if (fermante < 0) continue;

    const declarateur = m[1];
    const estSaute = /\.\s*(skip|todo|fails)\b/.test(m[0]);

    // Titre = premier littéral chaîne dans les arguments.
    const lits = litteraux(src, genres, ouvrante + 1, fermante);
    const titre = lits.length > 0 ? denuder(lits[0]) : '(sans titre)';

    // On ferme d'abord les `describe` dont la portée est terminée.
    while (describes.length > 0 && debutMot > describes[describes.length - 1].fin) describes.pop();

    if (declarateur === 'describe') {
      describes.push({ titre, fin: fermante });
      continue;
    }

    // Corps = tout l'appel sauf le titre. On repart après la fin du premier
    // littéral pour ne pas faire entrer le titre dans la signature.
    const finTitre = src.indexOf(lits[0] ?? '', ouvrante + 1);
    const debutCorps = finTitre >= 0 ? finTitre + (lits[0]?.length ?? 0) : ouvrante + 1;
    const normalise = normaliser(src, genres, debutCorps, fermante);
    const valeurs = litteraux(src, genres, debutCorps, fermante).map(denuder);

    const cheminTitre = [...describes.map((d) => d.titre), titre].join(' ');
    cas.push({
      fichier: relatif,
      ligne: ligneDe(src, debutMot),
      titre,
      cheminTitre,
      saute: estSaute,
      lignesCorps: (src.slice(debutCorps, fermante).match(/\n/g) || []).length + 1,
      normalise,
      valeurs,
      appels: appelsDe(normalise),
      assertions: assertionsDe(normalise),
    });
  }
  return cas;
}

/** Retire les délimiteurs d'un littéral. */
function denuder(lit) {
  if (lit.length >= 2) {
    const a = lit[0];
    const b = lit[lit.length - 1];
    if ((a === "'" || a === '"' || a === '`') && a === b) return lit.slice(1, -1);
  }
  return lit;
}

// ──────────────────────────── 4. Les durées ─────────────────────────────────
//
// `apps/qa/data/tests.ndjson` est la mémoire test par test du portail qualité :
// une ligne par cas, avec le `dureeMs` de la dernière exécution en CI. C'est la
// seule source de durée qui couvre TOUT le dépôt sans relancer quoi que ce
// soit. Un cas absent (fichier jamais passé en CI, ou renommé depuis) sort du
// calcul de coût mais reste dans le rapport, signalé comme sans durée.

function chargerDurees() {
  const fichier = join(RACINE, 'apps', 'qa', 'data', 'tests.ndjson');
  const parFichier = new Map();
  let total = 0;
  let lignes;
  try {
    lignes = readFileSync(fichier, 'utf8').split('\n');
  } catch {
    return { parFichier, source: null, total: 0 };
  }
  for (const ligne of lignes) {
    if (ligne.trim() === '') continue;
    let entree;
    try {
      entree = JSON.parse(ligne);
    } catch {
      continue;
    }
    if (typeof entree.dureeMs !== 'number') continue;
    total += entree.dureeMs;
    if (!parFichier.has(entree.fichier)) parFichier.set(entree.fichier, []);
    parFichier.get(entree.fichier).push(entree);
  }
  return { parFichier, source: 'apps/qa/data/tests.ndjson', total };
}

/**
 * Rattache une durée à un cas. La mémoire range les titres sous leur forme
 * complète (`describe` concaténés) ; l'extraction, elle, reconstruit ce chemin
 * mais peut le rater quand un titre est calculé à l'exécution. On essaie donc
 * l'égalité exacte, puis le suffixe.
 */
function dureeDe(cas, parFichier) {
  const entrees = parFichier.get(cas.fichier);
  if (!entrees) return null;
  const exact = entrees.find((e) => e.titre === cas.cheminTitre);
  if (exact) return exact.dureeMs;
  const suffixe = entrees.filter((e) => e.titre.endsWith(cas.titre));
  if (suffixe.length === 1) return suffixe[0].dureeMs;
  return null;
}

// ───────────────────────────── 5. Détection ─────────────────────────────────

/** Deux listes de littéraux diffèrent d'au plus `max` positions ? */
function diffLitteraux(a, b, max) {
  if (a.length !== b.length) return Infinity;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      n++;
      if (n > max) return Infinity;
    }
  }
  return n;
}

export function detecter(cas) {
  // (a) — corps identiques après normalisation.
  const parSignature = new Map();
  for (const c of cas) {
    // Un corps trop court ne prouve rien : `expect(f()).toBe(§)` se retrouve
    // partout et légitimement. Le seuil coupe le bruit sans rien cacher
    // d'intéressant — sous 40 caractères normalisés il n'y a pas de fusion à
    // faire, juste des assertions courtes sur des sujets différents.
    if (c.normalise.length < 40) continue;
    const cle = c.normalise;
    if (!parSignature.has(cle)) parSignature.set(cle, []);
    parSignature.get(cle).push(c);
  }
  const certains = [];
  for (const [cle, membres] of parSignature) {
    if (membres.length < 2) continue;
    // Les membres ont le même corps À LA VALEUR PRÈS. Ceux qui partagent AUSSI
    // leurs littéraux sont des copies pures.
    const copiesPures = membres.every(
      (m) => JSON.stringify(m.valeurs) === JSON.stringify(membres[0].valeurs),
    );
    certains.push({
      niveau: 'certain',
      signature: cle,
      copiesPures,
      membres,
      memeFichier: new Set(membres.map((m) => m.fichier)).size === 1,
    });
  }

  // (b) — mêmes appels + mêmes assertions, ≤ 1 littéral différent, corps NON
  // identiques (sinon c'est déjà un (a)).
  const dejaCertain = new Set();
  for (const g of certains) for (const m of g.membres) dejaCertain.add(m);

  const parForme = new Map();
  for (const c of cas) {
    if (dejaCertain.has(c)) continue;
    if (c.assertions.length === 0) continue;
    if (c.normalise.length < 40) continue;
    const cle = `${c.appels.join('>')}||${c.assertions.join('>')}`;
    if (!parForme.has(cle)) parForme.set(cle, []);
    parForme.get(cle).push(c);
  }
  const probables = [];
  for (const [cle, membres] of parForme) {
    if (membres.length < 2) continue;
    // Dans une forme, on ne retient que les paires à ≤ 1 littéral d'écart. On
    // les agglomère en composantes connexes : un groupe est un ensemble de cas
    // reliés deux à deux.
    const parent = membres.map((_, i) => i);
    const racineDe = (i) => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
    let uneParaire = false;
    for (let i = 0; i < membres.length; i++) {
      for (let j = i + 1; j < membres.length; j++) {
        if (diffLitteraux(membres[i].valeurs, membres[j].valeurs, 1) <= 1) {
          parent[racineDe(j)] = racineDe(i);
          uneParaire = true;
        }
      }
    }
    if (!uneParaire) continue;
    const composantes = new Map();
    for (let i = 0; i < membres.length; i++) {
      const r = racineDe(i);
      if (!composantes.has(r)) composantes.set(r, []);
      composantes.get(r).push(membres[i]);
    }
    for (const groupe of composantes.values()) {
      if (groupe.length < 2) continue;
      probables.push({
        niveau: 'probable',
        signature: cle,
        copiesPures: false,
        membres: groupe,
        memeFichier: new Set(groupe.map((m) => m.fichier)).size === 1,
      });
    }
  }

  return { certains, probables };
}

// ────────────────────────────── 6. Rapport ──────────────────────────────────

function ms(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1000) return `${n.toFixed(0)} ms`;
  return `${(n / 1000).toFixed(1)} s`;
}

function echapper(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * Un détecteur qu'on n'a pas vérifié ne vaut rien. Les cinq premiers groupes
 * « certains » du classement ont été relus À LA MAIN le 2026-09-12, code sous
 * les yeux. Le texte ci-dessous est ce constat, écrit une fois — il ne se
 * recalcule pas, et il doit être refait si le détecteur change.
 */
const VERIFICATION_MAIN = `## Ce que valent ces groupes — cinq relus à la main

Relus le 2026-09-12, en ouvrant le code sous test, pas seulement les titres.

**1. \`approval-rule-scope.test.ts:62\` + \`internal-tool-toggles.test.ts:102\` — VRAI.**
Les deux appellent \`setAgentApprovalRuleAction\` et relisent la ligne écrite.
Lu dans \`apps/web/src/lib/actions.ts:6230\` : \`toolName\` y est opaque — pas de
branche pour un joker \`cogni_cortex__*\`, pas de branche pour un outil interne.
Le \`action: 'block'\` du second traverse une garde de plus
(\`UNBLOCKABLE_TOOLS\`), qui ne fait rien pour \`web_search\`. Même branche
d'écriture, même assertion : l'un ne peut pas tomber sans l'autre. Vrai
chevauchement — mais un mauvais candidat à la fusion : les deux fichiers montent
leur propre base et leurs propres mocks, et le second n'existe que pour son
voisin (\`return_result\` ne peut PAS être bloqué). À laisser.

**2 et 3. Les 25 \`architecture.test.ts\` (\`scanForAgentSlugs\`, \`scanForHardcodedUuids\`) — FAUX.**
Corps identiques au caractère près, oui. Mais chacun passe le \`srcDir\` de SON
paquet : \`join(fileURLToPath(import.meta.url), '..', '..')\`. Le test de
\`packages/llm\` tombe quand \`packages/llm\` viole l'invariant #1, et lui seul.
Ils ne peuvent pas tomber ensemble — c'est exactement le contraire du critère.
C'est d'ailleurs le mécanisme que \`CLAUDE.md\` désigne comme l'application des
invariants #1, #2 et #6. Les fusionner supprimerait la protection de 24 paquets.

**4 et 5. \`/ask\` sur discord / slack / whatsapp — FAUX.**
Trois fichiers, trois modules : \`handleDiscordMessage\`, \`handleSlackMessage\`,
\`handleWhatsappMessage\`. Même scénario, trois implémentations distinctes ; une
régression dans le routage Slack ne fait pas rougir Discord. Duplication de
CODE DE TEST, réelle — une table de scénarios partagée serait un gain de
maintenance — mais pas un chevauchement qui coûte sans protéger.

**Taux de faux positifs constaté : 4 sur 5 (80 %).** Les quatre ont la même
cause : le groupe s'étale sur plusieurs fichiers qui testent des modules
différents. D'où la colonne « un seul fichier / plusieurs fichiers » ajoutée au
classement. Sur les groupes internes à UN fichier, le détecteur n'a pas été
mis en défaut ici — mais cinq relectures ne suffisent pas à l'affirmer.

Le détecteur lui-même a ses tests
(\`scripts/tests/audit-tests-chevauchement.test.mjs\`), et ils ont été vérifiés
PAR MUTATION : couper la reconnaissance des commentaires, des chaînes, des
expressions régulières ou du marqueur « même fichier » les fait rougir à chaque
fois. La première version du test sur le découpage lexical survivait à tout —
elle plaçait des accolades là où c'est la parenthèse qui délimite un \`it(...)\`.
Elle ne prouvait rien ; elle a été réécrite.`;

function construireRapport({ cas, groupes, durees, fichiers, date }) {
  const L = [];
  const totalCas = cas.length;
  const certains = groupes.certains;
  const probables = groupes.probables;

  const casDans = (gs) => {
    const s = new Set();
    for (const g of gs) for (const m of g.membres) s.add(m);
    return s;
  };
  const casCertains = casDans(certains);
  const casProbables = casDans(probables);

  // Le gain d'un groupe : on garde un membre, on économise les autres.
  const gainDe = (g) => {
    const ds = g.membres.map((m) => m.duree).filter((d) => typeof d === 'number');
    if (ds.length < 2) return { gain: null, mesures: ds.length };
    ds.sort((a, b) => b - a);
    return { gain: ds.slice(1).reduce((a, b) => a + b, 0), mesures: ds.length };
  };
  for (const g of [...certains, ...probables]) Object.assign(g, gainDe(g));

  const gainCertain = certains.reduce((a, g) => a + (g.gain ?? 0), 0);
  const gainProbable = probables.reduce((a, g) => a + (g.gain ?? 0), 0);
  const sansDuree = cas.filter((c) => typeof c.duree !== 'number').length;

  const intra = [...certains, ...probables].filter((g) => g.memeFichier);
  const inter = [...certains, ...probables].filter((g) => !g.memeFichier);
  const gainIntra = intra.reduce((a, g) => a + (g.gain ?? 0), 0);
  const gainInter = inter.reduce((a, g) => a + (g.gain ?? 0), 0);
  const part = durees.total > 0 ? ((gainCertain + gainProbable) / durees.total) * 100 : 0;

  L.push('# Audit des tests qui se chevauchent');
  L.push('');
  L.push(`_Mesure du ${date}. Rejouable : \`node scripts/audit-tests-chevauchement.mjs\`._`);
  L.push('');
  L.push('**Aucun test n’a été modifié pour produire ce rapport.**');
  L.push('');
  L.push('## Ce que la mesure dit');
  L.push('');
  L.push(
    `Le chevauchement existe — ${casCertains.size + casProbables.size} cas sur ${totalCas} sont ` +
      `dans un groupe — mais **il ne coûte quasiment rien**. Tout fusionner rendrait ` +
      `**${ms(gainCertain + gainProbable)}** sur les **${ms(durees.total)}** que l’exécution ` +
      `des corps de test représente au total, soit **${part.toFixed(2)} %**. Les 19,5 minutes ` +
      'médianes d’une PR ne viennent pas de là.',
  );
  L.push('');
  L.push(
    'Et la part qui reste se divise en deux, très inégalement. Les groupes dont les membres ' +
      `vivent **dans le même fichier** (${intra.length} groupes, ${ms(gainIntra)}) sont de vrais ` +
      'candidats à la fusion. Ceux qui s’étalent **sur plusieurs fichiers** ' +
      `(${inter.length} groupes, ${ms(gainInter)}) sont presque toujours le même scénario joué ` +
      'contre des modules différents — les 28 `architecture.test.ts`, les trois handlers de ' +
      'canal — et là, fusionner supprimerait de la protection. La vérification à la main du § ' +
      '« Ce que valent ces groupes » le montre sur cinq cas.',
  );
  L.push('');
  L.push('## Les chiffres');
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| Fichiers de test parcourus | ${fichiers} |`);
  L.push(`| Cas extraits (\`it\` / \`test\`) | ${totalCas} |`);
  L.push(`| Cas dont la durée est connue | ${totalCas - sansDuree} |`);
  L.push(`| Temps d’exécution de tous les cas mesurés | ${ms(durees.total)} |`);
  L.push(`| Groupes **certains** | ${certains.length} |`);
  L.push(`| Cas dans un groupe certain | ${casCertains.size} |`);
  L.push(`| Groupes **probables** | ${probables.length} |`);
  L.push(`| Cas dans un groupe probable | ${casProbables.size} |`);
  L.push(`| Groupes internes à un seul fichier | ${intra.length} |`);
  L.push(`| Groupes étalés sur plusieurs fichiers | ${inter.length} |`);
  L.push(`| Temps récupérable, groupes certains | ${ms(gainCertain)} |`);
  L.push(`| Temps récupérable, groupes probables | ${ms(gainProbable)} |`);
  L.push(`| Temps récupérable, groupes d’un seul fichier | ${ms(gainIntra)} |`);
  L.push(
    `| Temps récupérable, total | **${ms(gainCertain + gainProbable)}** (${part.toFixed(2)} %) |`,
  );
  L.push('');
  L.push(
    `Source des durées : \`${durees.source ?? 'aucune — les colonnes de temps sont vides'}\`. ` +
      'C’est la mémoire test par test du portail qualité, alimentée par le ' +
      '`--reporter=json` de `qa.yml`. Aucune suite n’a été relancée pour ce rapport.',
  );
  L.push('');

  // Par fichier.
  L.push('## Par fichier');
  L.push('');
  const parFichier = new Map();
  for (const g of [...certains, ...probables]) {
    for (const m of g.membres) {
      if (!parFichier.has(m.fichier))
        parFichier.set(m.fichier, { certain: 0, probable: 0, gain: 0, total: 0 });
      const e = parFichier.get(m.fichier);
      e[g.niveau]++;
    }
    // Le gain est imputé au fichier du membre le plus lent — celui qu'on
    // garderait ou qu'on supprimerait selon la décision.
    const membresTries = [...g.membres].sort((a, b) => (b.duree ?? 0) - (a.duree ?? 0));
    for (const m of membresTries.slice(1)) {
      if (typeof m.duree === 'number') parFichier.get(m.fichier).gain += m.duree;
    }
  }
  for (const c of cas) {
    if (!parFichier.has(c.fichier)) continue;
    parFichier.get(c.fichier).total++;
  }
  const lignesFichier = [...parFichier.entries()].sort((a, b) => b[1].gain - a[1].gain);
  L.push('| Fichier | Cas | Certains | Probables | Temps récupérable |');
  L.push('|---|---:|---:|---:|---:|');
  for (const [f, e] of lignesFichier.slice(0, 40)) {
    L.push(`| \`${f}\` | ${e.total} | ${e.certain} | ${e.probable} | ${ms(e.gain)} |`);
  }
  if (lignesFichier.length > 40) {
    L.push(`| … et ${lignesFichier.length - 40} autres fichiers | | | | |`);
  }
  L.push('');

  // Les 20 groupes les plus coûteux.
  L.push('## Les vingt groupes les plus coûteux');
  L.push('');
  L.push(
    'Triés par le temps de CI qu’une fusion rendrait. Pour chaque groupe : ce que les cas exercent, et ce que la fusion donnerait.',
  );
  L.push('');
  const tous = [...certains, ...probables].sort((a, b) => (b.gain ?? -1) - (a.gain ?? -1));
  let rang = 0;
  for (const g of tous.slice(0, 20)) {
    rang++;
    const libelle = g.niveau === 'certain' ? 'certain' : 'probable';
    L.push(
      `### ${rang}. ${g.membres.length} cas — ${libelle}${g.copiesPures ? ', copies pures' : ''} — ${g.memeFichier ? 'un seul fichier' : 'plusieurs fichiers'} — ${ms(g.gain)} récupérables`,
    );
    L.push('');
    L.push(
      `**Fichier${new Set(g.membres.map((m) => m.fichier)).size > 1 ? 's' : ''} :** ${[...new Set(g.membres.map((m) => `\`${m.fichier}\``))].join(', ')}`,
    );
    L.push('');
    L.push('| Ligne | Titre | Durée |');
    L.push('|---:|---|---:|');
    for (const m of [...g.membres].sort((a, b) => (b.duree ?? 0) - (a.duree ?? 0))) {
      L.push(`| ${m.ligne} | ${echapper(m.titre)} | ${ms(m.duree)} |`);
    }
    L.push('');
    const ex = g.membres[0];
    L.push(
      `**Ce qu’ils exercent :** ${ex.appels.slice(0, 8).join(', ') || '(aucun appel repéré)'}${ex.appels.length > 8 ? ', …' : ''}.`,
    );
    L.push(`**Assertions :** ${ex.assertions.join(', ') || '(aucune)'}.`);
    const variantes = g.membres.map((m) => m.valeurs).filter((v) => v.length > 0);
    if (variantes.length > 1) {
      const positions = [];
      for (let i = 0; i < variantes[0].length; i++) {
        const vus = new Set(variantes.map((v) => v[i]));
        if (vus.size > 1) positions.push({ i, vus: [...vus] });
      }
      if (positions.length > 0) {
        L.push(
          `**Ce qui varie :** ${positions
            .slice(0, 3)
            .map(
              (p) =>
                `littéral #${p.i + 1} (${p.vus.map((v) => `\`${echapper(String(v).slice(0, 40))}\``).join(' / ')})`,
            )
            .join(' ; ')}.`,
        );
      }
    }
    L.push(
      `**Fusion :** ${
        g.copiesPures
          ? `copies identiques — en garder **un**, supprimer les ${g.membres.length - 1} autres.`
          : g.niveau === 'certain'
            ? `un \`test.each\` de ${g.membres.length} lignes, une ligne par variante — mécanique, sans perte.`
            : 'à relire : la différence restante est soit du bruit, soit toute la valeur du test.'
      }`,
    );
    L.push('');
  }

  L.push(VERIFICATION_MAIN);
  L.push('');
  L.push('## Limites de la méthode');
  L.push('');
  L.push(
    [
      "- **La normalisation garde les identifiants.** Deux tests qui font la même chose en passant par des variables nommées différemment ne sont PAS appariés. C'est un choix : effacer les identifiants ferait se ressembler deux tests qui n'appellent pas la même fonction, et un faux positif coûte plus cher ici qu'un manque.",
      '- **Un corps sous 40 caractères normalisés est ignoré.** Un `expect(f()).toBe(§)` se retrouve partout, légitimement, sur des sujets différents. Le seuil coupe ce bruit — et cache donc, par construction, les vraies duplications très courtes.',
      "- **Ce que le détecteur ne voit pas du tout :** les fixtures et `beforeEach` partagés (deux cas au corps différent peuvent exercer la même branche parce que toute la mise en place est ailleurs) ; deux cas qui exercent la même branche par deux chemins d'appel différents ; l'équivalence sémantique entre `toBe(true)` et `toEqual(expect.objectContaining(…))`.",
      "- **Faux positifs plausibles.** Un `test.each` déjà en place produit des cas au corps identique — le détecteur les voit comme un groupe, alors que la fusion est déjà faite. Un test nommé d'après un incident réel peut avoir le même corps qu'un test générique tout en exerçant une entrée qui, elle, documente le cas : le groupe est réel, la suppression serait une perte. C'est pourquoi la colonne « ce qui varie » est dans le rapport.",
      "- **`tests.ndjson` est un fichier VERSIONNÉ, donc il dépend de la branche.** Une branche qui le réinitialise fait sortir un rapport à zéro seconde, sans rien signaler — c'est arrivé pendant l'écriture de cet audit, sur une branche voisine. Ce rapport doit être régénéré depuis `main`, ou depuis une branche qui n'y touche pas. La ligne « temps d'exécution de tous les cas mesurés » est le témoin : à 1 428,7 s la mémoire est complète, très en dessous elle est tronquée.",
      "- **`dureeMs` est le temps du CORPS, pas le coût complet.** Le montage du fichier (imports, `beforeAll`, `spinUpTestDb`) n'y est pas. Supprimer des cas à l'intérieur d'un fichier ne rend donc que ce que le rapport annonce ; supprimer un fichier ENTIER rendrait davantage. Aucun groupe ici ne couvre un fichier entier.",
      "- **Les durées sont celles d'une exécution, pas une moyenne.** `tests.ndjson` porte le `dureeMs` du dernier passage en CI. Un cas lent par accident (contention disque sur le runner) gonfle son groupe. Les ordres de grandeur tiennent, pas les secondes.",
      "- **Les cas sans durée sortent du calcul de coût.** Un fichier jamais passé en CI, un titre calculé à l'exécution, un `describe.each` : le cas figure au rapport, son temps est vide. Le total récupérable est donc un PLANCHER.",
      "- **Le e2e Playwright n'a pas de durée ici.** `tests.ndjson` est alimenté par vitest ; les spécifications Playwright ont leur propre rapport. Les groupes e2e apparaissent, leur coût non.",
      '- **Rien n’a été exécuté pour produire ce rapport.** Aucune conclusion ici ne dit qu’un test passe ou tombe — seulement que deux cas se ressemblent au point qu’il faut aller les lire.',
    ].join('\n'),
  );
  L.push('');
  return L.join('\n');
}

// ─────────────────────────────── 7. Main ────────────────────────────────────

function principal() {
  const args = process.argv.slice(2);
  const lire = (drapeau) => {
    const i = args.indexOf(drapeau);
    return i >= 0 ? args[i + 1] : null;
  };

  const racines = ['apps', 'packages', 'scripts'].map((d) => join(RACINE, d));
  const fichiers = [];
  for (const r of racines) {
    try {
      if (statSync(r).isDirectory()) fichiers.push(...listerFichiersTest(r));
    } catch {
      /* dossier absent : rien à parcourir */
    }
  }

  const cas = [];
  for (const f of fichiers) {
    try {
      cas.push(...extraireCas(f));
    } catch (err) {
      process.stderr.write(`  (non analysé : ${relative(RACINE, f)} — ${err.message})\n`);
    }
  }

  const durees = chargerDurees();
  for (const c of cas) c.duree = dureeDe(c, durees.parFichier);

  const groupes = detecter(cas.filter((c) => !c.saute));

  const date = new Date().toISOString().slice(0, 10);
  const rapport = construireRapport({
    cas,
    groupes,
    durees,
    fichiers: fichiers.length,
    date,
  });

  const sortie = lire('--out');
  if (sortie) {
    writeFileSync(join(RACINE, sortie), rapport, 'utf8');
    process.stdout.write(`Rapport écrit : ${sortie}\n`);
  } else {
    process.stdout.write(rapport);
  }

  const json = lire('--json');
  if (json) {
    writeFileSync(
      join(RACINE, json),
      JSON.stringify(
        {
          totalCas: cas.length,
          fichiers: fichiers.length,
          groupes: [...groupes.certains, ...groupes.probables].map((g) => ({
            niveau: g.niveau,
            copiesPures: g.copiesPures,
            gain: g.gain,
            membres: g.membres.map((m) => ({
              fichier: m.fichier,
              ligne: m.ligne,
              titre: m.titre,
              duree: m.duree,
            })),
          })),
        },
        null,
        2,
      ),
      'utf8',
    );
    process.stdout.write(`Données écrites : ${json}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) principal();
