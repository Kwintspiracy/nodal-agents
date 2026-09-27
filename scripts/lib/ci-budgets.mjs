// ci-budgets.mjs — les bornes de temps de la CI, vérifiées par la machine (#517).
//
// Pourquoi : quand la borne d'un JOB est plus courte que la somme des bornes de
// ses étapes, c'est le job qui tombe le premier, et il emporte tout ce qui le
// suit (le journal de la stack, le rapport Playwright, la collecte de la nuit).
// Une borne d'ÉTAPE, elle, laisse tourner les étapes `if: failure()` /
// `if: always()`. La PR #516 a demandé quatre passes de revue pour tenir cette
// somme à la main ; la prochaine étape ajoutée la rouvrait. Ce contrôle la tient.
//
// Les règles, pour chaque job de chaque workflow :
//   1. le job porte un `timeout-minutes` numérique ;
//   2. toute étape `run:` porte un `timeout-minutes` numérique, sauf une étape
//      TRIVIALE (seulement echo, mkdir, rm, cp, mv, printf, cat, ls, test) ;
//   3. borne du job ≥ somme des bornes des étapes + une marge fixe pour les
//      étapes `uses:` de mise en place (checkout, setup, cache, upload).
//
// Le lecteur ne comprend que la forme des workflows du dépôt (formatés par
// Prettier : jobs à deux espaces, clés de job à quatre, étapes à six, clés
// d'étape à huit). Une forme qu'il ne lit pas est un CONSTAT, jamais un vert.

/** La marge, en minutes, laissée aux étapes `uses:` d'un job. */
export const MARGE_USES_MIN = 5;

const TRIVIAL = /^(echo|mkdir|rm|cp|mv|printf|cat|ls|test|true)\b/;

/** Les lignes utiles : sans commentaire pur ni ligne vide, avec leur indentation. */
function lignes(texte) {
  return texte
    .split(/\r?\n/)
    .map((brut, i) => ({ brut, n: i + 1, indent: brut.length - brut.trimStart().length }))
    .filter((l) => l.brut.trim() !== '' && !l.brut.trim().startsWith('#'));
}

function valeur(ligne, cle) {
  const m = ligne.brut.trimStart().match(new RegExp(`^(?:- )?${cle}:\\s*(.*)$`));
  return m ? m[1].trim() : undefined;
}

function minutes(v) {
  if (v === undefined) return undefined;
  return /^\d+(\.\d+)?$/.test(v) ? Number(v) : Number.NaN;
}

/**
 * Lit un workflow : ses jobs, leur borne, et leurs étapes (nom, genre, script,
 * borne, ligne). `run` vaut le script entier, bloc `|` compris.
 */
export function lireWorkflow(texte) {
  const ls = lignes(texte);
  const jobs = [];
  let dansJobs = false;
  let job = null;
  let dansSteps = false;
  let etape = null;
  let blocRun = null;
  for (const l of ls) {
    // Le contenu d'un bloc `run: |` : plus indenté que la clé `run`.
    if (blocRun !== null) {
      if (l.indent > blocRun.indent) {
        etape.run += (etape.run ? '\n' : '') + l.brut.trim();
        continue;
      }
      blocRun = null;
    }
    if (l.indent === 0) {
      dansJobs = /^jobs:\s*$/.test(l.brut);
      job = null;
      continue;
    }
    if (!dansJobs) continue;
    if (l.indent === 2 && /^  [A-Za-z0-9_-]+:\s*$/.test(l.brut)) {
      job = { nom: l.brut.trim().slice(0, -1), ligne: l.n, timeout: undefined, etapes: [] };
      jobs.push(job);
      dansSteps = false;
      etape = null;
      continue;
    }
    if (job === null) continue;
    if (l.indent === 4) {
      dansSteps = /^steps:\s*$/.test(l.brut.trim());
      const t = valeur(l, 'timeout-minutes');
      if (t !== undefined) job.timeout = minutes(t);
      continue;
    }
    if (!dansSteps) continue;
    if (l.indent === 6 && l.brut.trimStart().startsWith('- ')) {
      etape = { nom: undefined, ligne: l.n, genre: undefined, run: undefined, timeout: undefined };
      job.etapes.push(etape);
      // La première clé peut être sur la ligne du tiret.
      lireCle(l, etape, (b) => (blocRun = b));
      continue;
    }
    if (etape !== null && l.indent === 8) lireCle(l, etape, (b) => (blocRun = b));
  }
  for (const j of jobs) for (const e of j.etapes) e.nom ??= e.run?.split('\n')[0] ?? e.genre ?? '?';
  return jobs;
}

function lireCle(l, etape, ouvrirBloc) {
  const nom = valeur(l, 'name');
  if (nom !== undefined) etape.nom = nom.replace(/^['"]|['"]$/g, '');
  const uses = valeur(l, 'uses');
  if (uses !== undefined) etape.genre = 'uses';
  const t = valeur(l, 'timeout-minutes');
  if (t !== undefined) etape.timeout = minutes(t);
  const run = valeur(l, 'run');
  if (run !== undefined) {
    etape.genre = 'run';
    if (/^[|>][-+]?$/.test(run)) {
      etape.run = '';
      ouvrirBloc({ indent: l.indent });
    } else {
      etape.run = run;
    }
  }
}

/** Une étape `run:` qui ne fait que des gestes triviaux, sans borne à poser. */
export function estTriviale(run) {
  const cmds = run
    .split(/\n|&&|;/)
    .map((c) => c.trim())
    .filter((c) => c !== '');
  return cmds.length > 0 && cmds.every((c) => TRIVIAL.test(c));
}

/** Les constats d'un workflow ; un tableau vide veut dire : tenu. */
export function verifierWorkflow(fichier, texte, marge = MARGE_USES_MIN) {
  const constats = [];
  for (const job of lireWorkflow(texte)) {
    const ou = `${fichier} › ${job.nom}`;
    if (job.timeout === undefined || Number.isNaN(job.timeout)) {
      constats.push(`${ou} (line ${job.ligne}): the job has no numeric timeout-minutes`);
    }
    let somme = 0;
    const nonBornees = [];
    for (const e of job.etapes) {
      if (e.timeout !== undefined && Number.isNaN(e.timeout)) {
        constats.push(`${ou} › "${e.nom}" (line ${e.ligne}): timeout-minutes is not a number`);
        continue;
      }
      if (e.timeout !== undefined) somme += e.timeout;
      else if (e.genre === 'run' && !estTriviale(e.run ?? '')) nonBornees.push(e);
    }
    for (const e of nonBornees) {
      constats.push(`${ou} › "${e.nom}" (line ${e.ligne}): a run step without timeout-minutes`);
    }
    if (job.timeout !== undefined && !Number.isNaN(job.timeout) && job.timeout < somme + marge) {
      constats.push(
        `${ou}: job timeout ${job.timeout} min < steps ${somme} min + ${marge} min for setup steps; a job timeout would cut a step before its own bound`,
      );
    }
  }
  return constats;
}
