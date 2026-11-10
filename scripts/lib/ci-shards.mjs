// ci-shards.mjs — aucune suite de tests ne tombe entre les tranches de la CI.
//
// Pourquoi : le job `test` de ci.yml coupe la suite unitaire en tranches (web,
// runner, et les autres paquets en deux), chacune lancée par un filtre turbo.
// Un paquet que plus aucun filtre ne nomme n'est plus testé, et la CI reste
// VERTE : c'est un faux vert, le pire des défauts d'une porte. Il suffit pour
// cela d'une tranche écrite comme une liste (`--filter=a --filter=b`) à
// laquelle on oublie d'ajouter un paquet neuf. Ce contrôle lit les VRAIS
// filtres et les compare aux paquets du dépôt.
//
// Les règles, pour l'ensemble des tranches du job `test` :
//   1. chaque paquet du dépôt qui a un script `test` est dans EXACTEMENT une
//      tranche de paquets (ni perdu, ni lancé deux fois) ;
//   2. `web` et `runner`, coupés par fichier (`-- --shard=k/n`), portent chacun
//      toutes leurs moitiés : 1/2 et 2/2, jamais deux fois la même ;
//   3. un filtre que le lecteur ne comprend pas est un CONSTAT (jamais un vert).
//
// Et pour les DEUX workflows qui lancent la suite (ci.yml sous Linux,
// ci-windows.yml sous Windows) : `divergences` exige les mêmes tranches, les
// mêmes commandes. Les limites de temps, propres à chaque OS, ne sont pas
// comparées (elles sont tenues par scripts/lib/ci-budgets.mjs).
//
// Sémantique turbo lue ici : les filtres positifs s'additionnent ; s'il n'y en
// a aucun, on part de tous les paquets ; les filtres `!x` retirent ensuite.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Les paquets coupés par fichier plutôt que listés dans une tranche de paquets. */
export const COUPES_PAR_FICHIER = ['@nodal-agents/web', '@nodal-agents/runner'];

/**
 * Les tranches du job `test` : `{ tranche, run }` pour chaque entrée de sa
 * matrice. Le lecteur ne comprend que la forme du dépôt (clé `- shard:` suivie
 * de sa ligne `run:`).
 */
export function lireTranches(yml) {
  const lignes = yml.split(/\r?\n/);
  const debut = lignes.findIndex((l) => /^ {2}test:\s*$/.test(l));
  if (debut === -1) throw new Error('ci-shards: le job `test` est introuvable dans ci.yml');
  let fin = lignes.findIndex((l, i) => i > debut && /^ {2}\S/.test(l));
  if (fin === -1) fin = lignes.length;
  const tranches = [];
  for (let i = debut; i < fin; i++) {
    const m = /^\s*-\s*shard:\s*(\S+)\s*$/.exec(lignes[i]);
    if (!m) continue;
    const run = /^\s*run:\s*(.+?)\s*$/.exec(lignes[i + 1] ?? '');
    if (!run)
      throw new Error(`ci-shards: la tranche ${m[1]} n'a pas de \`run:\` sur la ligne suivante`);
    tranches.push({ tranche: m[1], run: run[1] });
  }
  if (tranches.length === 0) throw new Error('ci-shards: le job `test` ne déclare aucune tranche');
  return tranches;
}

/** Les filtres turbo d'une commande, et la moitié `--shard=k/n` passée à vitest après ` -- `. */
export function lireCommande(run) {
  const [partieTurbo, ...apres] = run.split(' -- ');
  const inclus = [];
  const exclus = [];
  for (const m of partieTurbo.matchAll(/--filter[= ](\S+)/g)) {
    const filtre = m[1];
    const negatif = filtre.startsWith('!');
    const nom = negatif ? filtre.slice(1) : filtre;
    if (!/^@?[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/.test(nom)) {
      throw new Error(
        `ci-shards: filtre turbo non lu « ${filtre} » (seuls les noms de paquet sont lus)`,
      );
    }
    (negatif ? exclus : inclus).push(nom);
  }
  const fichier = /--shard=(\d+\/\d+)/.exec(apres.join(' -- '));
  return { inclus, exclus, moitie: fichier ? fichier[1] : null };
}

/** Les paquets du dépôt qui ont un script `test` : `{ nom, dossier }`. */
export function paquetsAvecTests(racine) {
  const globs = readFileSync(join(racine, 'pnpm-workspace.yaml'), 'utf-8')
    .split(/\r?\n/)
    .map((l) => /^\s*-\s*'([^']+)'\s*$/.exec(l)?.[1])
    .filter(Boolean);
  const paquets = [];
  for (const g of globs) {
    if (!g.endsWith('/*')) throw new Error(`ci-shards: glob de workspace non lu « ${g} »`);
    const parent = g.slice(0, -2);
    if (!existsSync(join(racine, parent))) continue;
    for (const e of readdirSync(join(racine, parent), { withFileTypes: true })) {
      const pj = join(racine, parent, e.name, 'package.json');
      if (!e.isDirectory() || !existsSync(pj)) continue;
      const json = JSON.parse(readFileSync(pj, 'utf-8'));
      if (json.scripts?.test) paquets.push({ nom: json.name, dossier: `${parent}/${e.name}` });
    }
  }
  return paquets;
}

/**
 * Ce que chaque tranche lance, parmi `tous` (les noms des paquets à tests).
 * Un nom de filtre qui n'est pas un paquet du dépôt est un constat.
 */
export function paquetsDeLaTranche({ inclus, exclus }, tous) {
  for (const nom of [...inclus, ...exclus]) {
    if (!tous.includes(nom)) {
      throw new Error(`ci-shards: le filtre « ${nom} » ne nomme aucun paquet à tests du dépôt`);
    }
  }
  const base = inclus.length > 0 ? inclus : tous;
  return base.filter((nom) => !exclus.includes(nom));
}

/**
 * Les constats pour un ci.yml donné (texte) et les noms des paquets à tests.
 * `[]` : chaque paquet est lancé par exactement une tranche de paquets, et
 * web / runner (`coupes`) par leurs deux moitiés, ni plus ni moins.
 */
export function constats(yml, tous, coupes = COUPES_PAR_FICHIER) {
  let tranches;
  try {
    tranches = lireTranches(yml).map((t) => ({ ...t, ...lireCommande(t.run) }));
  } catch (e) {
    return [e.message];
  }
  const out = [];
  const tenus = new Map(tous.map((nom) => [nom, []]));
  for (const t of tranches) {
    let lance;
    try {
      lance = paquetsDeLaTranche(t, tous);
    } catch (e) {
      out.push(`${t.tranche}: ${e.message}`);
      continue;
    }
    // Une moitié (`--shard=k/n`) ne vaut que pour UN paquet coupé par fichier :
    // sur une tranche de paquets, elle jetterait en silence la moitié des fichiers.
    if (t.moitie !== null && !(lance.length === 1 && coupes.includes(lance[0]))) {
      out.push(
        `${t.tranche}: \`--shard=${t.moitie}\` sur une tranche qui lance ${lance.join(', ') || 'rien'}`,
      );
    }
    for (const nom of lance) tenus.get(nom).push(t);
  }
  for (const [nom, par] of tenus) {
    const noms = par.map((t) => t.tranche).join(', ');
    if (par.length === 0) {
      out.push(`${nom}: aucune tranche ne le lance (suite perdue, CI verte à tort)`);
    } else if (coupes.includes(nom)) {
      const moities = par.map((t) => t.moitie ?? 'entier').sort();
      if (moities.join(' ') !== '1/2 2/2') {
        out.push(
          `${nom}: ses tranches (${noms}) portent [${moities.join(', ')}], attendu [1/2, 2/2]`,
        );
      }
    } else if (par.length > 1) {
      out.push(`${nom}: lancé par ${par.length} tranches (${noms})`);
    }
  }
  return out;
}

/**
 * Les écarts entre les tranches de deux workflows qui doivent lancer la MÊME
 * suite (ci.yml sous Linux, ci-windows.yml sous Windows) : une tranche absente
 * d'un côté, en trop, ou nommée pareil mais qui ne lance pas la même commande.
 * `[]` : les deux définissent exactement les mêmes tranches. Seule la commande
 * compte ; les limites de temps, propres à chaque OS, ne sont pas comparées.
 *
 * Pourquoi comparer, et ne pas se contenter de `constats` sur chaque fichier :
 * deux fichiers peuvent chacun couvrir tous les paquets et pourtant couper
 * autrement. Le jour où l'un est rééquilibré, l'autre doit l'être, ou la
 * mesure qui a justifié la coupe ne vaut plus pour lui.
 */
export function divergences(nomReference, ymlReference, nom, yml) {
  let ref;
  let autre;
  try {
    ref = lireTranches(ymlReference);
    autre = lireTranches(yml);
  } catch (e) {
    return [e.message];
  }
  const out = [];
  const parNom = new Map(autre.map((t) => [t.tranche, t.run]));
  for (const t of ref) {
    if (!parNom.has(t.tranche)) {
      out.push(`${t.tranche}: définie dans ${nomReference}, absente de ${nom}`);
    } else if (parNom.get(t.tranche) !== t.run) {
      out.push(
        `${t.tranche}: ${nomReference} lance « ${t.run} », ${nom} lance « ${parNom.get(t.tranche)} »`,
      );
    }
  }
  const connues = new Set(ref.map((t) => t.tranche));
  for (const t of autre) {
    if (!connues.has(t.tranche)) {
      out.push(`${t.tranche}: définie dans ${nom}, absente de ${nomReference}`);
    }
  }
  return out;
}
