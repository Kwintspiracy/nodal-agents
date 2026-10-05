// next-trace-scope.mjs — le traçage du build web est-il resté dans le dépôt ?
//
// POURQUOI (05/10/2026). `next build` traçait le dossier personnel de la machine
// qui construit : 1 776 635 fichiers par page (AppData, ComfyUI, les données
// Postgres de ~/.nodalai, les photos…), 238 Mo par manifeste, 12 Go de `.next`,
// 24,5 Go de tas et 16 min de build. Le pic dépendait du CONTENU du dossier
// personnel, pas du code : 13 Go le 20/09, 24,5 Go le 05/10, même machine.
//
// La cause est dans le traceur de Next (@vercel/nft) : il ÉVALUE `os.homedir()`
// au moment du build, et quand le résultat est un dossier, il le parcourt en
// entier. Son garde « hors de la base » ne regarde que les chemins relatifs qui
// commencent par `..` ; entre deux lecteurs Windows, `path.relative` rend un
// chemin ABSOLU, et le garde ne le voit pas. Le correctif est dans
// patches/next@16.3.0.patch ; cette porte est ce qui empêche le défaut de
// revenir sans bruit, par ce chemin-là ou par un autre.
//
// Elle lit les manifestes `.nft.json` du build — la liste des fichiers que
// Next recopie dans `.next/standalone` — et refuse tout chemin qui ne descend
// pas de la racine du dépôt. Elle ne lit pas `.next/standalone` lui-même : ses
// manifestes y sont recopiés à une autre profondeur, et leurs chemins relatifs,
// relus depuis là, ne désignent plus les mêmes fichiers.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, dirname, sep, parse } from 'node:path';

/** Exemples gardés par manifeste : assez pour reconnaître, pas pour noyer. */
const EXEMPLES = 5;

function dedans(racine, chemin) {
  const rel = relative(racine, chemin);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

function manifestes(dir, nextDir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === nextDir && entry.name === 'standalone') continue;
      manifestes(p, nextDir, out);
    } else if (entry.name.endsWith('.nft.json')) {
      out.push(p);
    }
  }
  return out;
}

/** Les segments d'un chemin absolu, racine comprise (`C:\`, `/`). */
function segments(chemin) {
  const { root } = parse(chemin);
  return [root, ...chemin.slice(root.length).split(sep).filter(Boolean)];
}

/**
 * Les dossiers d'où viennent les fichiers dehors, les plus gros d'abord.
 *
 * Regroupés sous leur plus proche ancêtre commun : pour le build du 05/10 cela
 * donne `C:\Users\kwint\AppData`, `…\ComfyUI`, `…\.nodalai` — ce qu'on cherche
 * pour comprendre d'où vient le poids. Des fichiers sur plusieurs racines n'ont
 * pas d'ancêtre commun ; ils se regroupent alors sous leur premier dossier.
 */
function dossiers(fichiers) {
  if (fichiers.size === 0) return [];
  let commun = null;
  for (const f of fichiers) {
    const parts = segments(dirname(f));
    if (commun === null) {
      commun = parts;
      continue;
    }
    let i = 0;
    while (i < commun.length && i < parts.length && commun[i] === parts[i]) i++;
    commun = commun.slice(0, i);
  }
  const profondeur = Math.max(commun.length, 1);
  const compte = new Map();
  for (const f of fichiers) {
    const parts = segments(f);
    // Un fichier posé directement dans l'ancêtre commun compte pour l'ancêtre.
    const n = parts.length - 1 > profondeur ? profondeur + 1 : profondeur;
    const cle = resolve(parts[0], ...parts.slice(1, n));
    compte.set(cle, (compte.get(cle) ?? 0) + 1);
  }
  return [...compte.entries()]
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir));
}

/**
 * Lit chaque `.nft.json` sous `nextDir` (hors `standalone`) et rend ceux qui
 * listent un fichier hors de `racine`.
 *
 * Un `.next` absent ou sans manifeste LÈVE : une porte qui n'a rien lu ne peut
 * pas dire « rien dehors » (invariant #4).
 *
 * @returns {{
 *   manifestsScanned: number,
 *   outside: { manifest: string, count: number, examples: string[] }[],
 *   directories: { dir: string, count: number }[],
 *   uniqueFiles: number,
 *   manifestBytes: number,
 * }}
 */
export function scanTracesOutsideRoot(nextDir, racine) {
  if (!existsSync(nextDir)) {
    throw new Error(`Cannot check the web build traces: ${nextDir} does not exist.`);
  }
  const liste = manifestes(nextDir, nextDir);
  if (liste.length === 0) {
    throw new Error(
      `Cannot check the web build traces: no .nft.json under ${nextDir}. ` +
        'A build that traced nothing is not a build that traced nothing outside.',
    );
  }
  const outside = [];
  const uniques = new Set();
  let manifestBytes = 0;
  for (const manifeste of liste) {
    manifestBytes += statSync(manifeste).size;
    const { files = [] } = JSON.parse(readFileSync(manifeste, 'utf8'));
    const base = dirname(manifeste);
    let count = 0;
    const examples = [];
    for (const f of files) {
      const chemin = resolve(base, f);
      if (dedans(racine, chemin)) continue;
      count++;
      uniques.add(chemin);
      if (examples.length < EXEMPLES) examples.push(chemin);
    }
    if (count > 0) outside.push({ manifest: relative(nextDir, manifeste), count, examples });
  }
  return {
    manifestsScanned: liste.length,
    outside,
    directories: dossiers(uniques),
    uniqueFiles: uniques.size,
    manifestBytes,
  };
}

const pluriel = (n, mot) => `${n.toLocaleString('en-US')} ${mot}${n === 1 ? '' : 's'}`;

/** Le message d'échec, ou `null` quand tout est resté dans le dépôt. */
export function formatTracesOutsideRoot(scan, racine) {
  if (scan.outside.length === 0) return null;
  const lignes = [
    `The web build traced ${pluriel(scan.uniqueFiles, 'file')} outside the repository (${racine}),`,
    `in ${pluriel(scan.outside.length, 'manifest')} of ${scan.manifestsScanned}.`,
    '',
    '  Next copies every traced file into .next/standalone, and the tracer walks a',
    '  traced directory whole: a build that leaves the repository costs memory and',
    "  time in proportion to what it finds there, and can ship the builder's files.",
    '',
    '  Where they come from (largest first):',
  ];
  for (const { dir, count } of scan.directories.slice(0, 10)) {
    lignes.push(`    ${dir}  —  ${pluriel(count, 'file')}`);
  }
  lignes.push('', '  Manifests:');
  for (const { manifest, count, examples } of scan.outside.slice(0, 10)) {
    lignes.push(`    ${manifest}  —  ${pluriel(count, 'file')}, e.g.`);
    for (const e of examples) lignes.push(`      ${e}`);
  }
  if (scan.outside.length > 10) lignes.push(`    … and ${scan.outside.length - 10} more`);
  lignes.push(
    '',
    '  The usual cause is a path the tracer can evaluate at build time — os.homedir(),',
    '  os.tmpdir() — that resolves outside the repository. See scripts/lib/next-trace-scope.mjs.',
  );
  return lignes.join('\n');
}
