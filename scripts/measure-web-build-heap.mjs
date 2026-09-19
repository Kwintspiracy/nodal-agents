#!/usr/bin/env node
// measure-web-build-heap.mjs — combien de mémoire demande `next build` du dashboard.
//
// Le build de release (`scripts/build-pack.mjs`) mesure déjà ce pic à chaque
// pack et le dit. Ce script sert à l'autre question : « et si on posait le
// plancher plus bas ? » — il rejoue le même build sous le cap qu'on lui donne,
// et rend le même couple de chiffres.
//
// Usage :
//   node scripts/measure-web-build-heap.mjs                 # cap = plancher de build-pack
//   node scripts/measure-web-build-heap.mjs --cap 16384     # essaie un plancher plus bas
//   node scripts/measure-web-build-heap.mjs --cap 16384 --json mesure.json
//   node scripts/measure-web-build-heap.mjs --enregistrer   # écrit la référence
//
// `--enregistrer` écrit `scripts/build-heap-reference.json`, que le build de
// pack relit pour dire si le pic a monté. Le script l'écrit lui-même parce
// qu'un chiffre recopié à la main finit par ne plus décrire aucune mesure —
// c'est exactement comme ça que le plancher a doublé sans mesure (#219).
//
// `apps/web/.next` est purgé avant : un build tiède ne mesure rien de
// reproductible — webpack relit son cache disque et le pic n'est plus le même.
// `build-pack.mjs` purge pour la même raison.

import { rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mesurerCommande, plancherPour, nodeOptionsAvecCap } from './lib/build-heap-sampler.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

/** Le plancher, lu là où il vit — pas un chiffre réécrit ici. */
export function lirePlancher(sourceBuildPack) {
  const m = /HEAP_FLOOR_MB\s*=\s*(\d+)/.exec(sourceBuildPack);
  if (!m) throw new Error('HEAP_FLOOR_MB introuvable dans scripts/build-pack.mjs');
  return Number(m[1]);
}

/** `--cap 16384` → 16384 ; absent → `defaut` ; illisible → on refuse. */
export function capDemande(args, defaut) {
  const i = args.indexOf('--cap');
  if (i === -1) return defaut;
  const valeur = Number(args[i + 1]);
  if (!Number.isFinite(valeur) || valeur <= 0) {
    throw new Error('--cap attend un nombre de Mo');
  }
  return valeur;
}

/**
 * La référence qu'on enregistre : le pic, et ce sans quoi il ne veut rien dire.
 *
 * La machine en fait partie. Le pic dépend du nombre de cœurs — `next build`
 * ouvre un worker par cœur pour la collecte des pages — et de la version de
 * Node. Un pic nu, sans la machine qui l'a produit, se compare à tort au
 * suivant et fait crier une alerte que personne ne peut trancher.
 */
export function referenceDepuis(
  mesure,
  { commit, cap, maintenant = new Date(), os = platformInfo },
) {
  return {
    _pourquoi:
      "Le dernier pic mesure du build web (#219). scripts/build-pack.mjs le compare a ce qu'il vient de mesurer et le dit quand il monte. Le re-enregistrer apres une mesure deliberee (node scripts/measure-web-build-heap.mjs --enregistrer), jamais pour faire taire l'alerte.",
    commit,
    date: maintenant.toISOString().slice(0, 10),
    machine: `${os.platform} ${os.cores} cœurs, node ${os.node}`,
    capMo: cap,
    picProcessusMo: mesure.picProcessusMo,
    picArbreMo: mesure.picArbreMo,
    secondes: mesure.secondes,
  };
}

const platformInfo = {
  platform: process.platform,
  cores: cpus().length,
  node: process.versions.node,
};

async function principal() {
  const args = process.argv.slice(2);
  const plancher = lirePlancher(readFileSync(resolve(repoRoot, 'scripts/build-pack.mjs'), 'utf8'));
  const cap = capDemande(args, plancher);

  const webNext = resolve(repoRoot, 'apps/web/.next');
  if (existsSync(webNext)) {
    console.log('▶ Purge de apps/web/.next (un build tiède ne se mesure pas)…');
    rmSync(webNext, { recursive: true, force: true });
  }

  const nodeOptions = nodeOptionsAvecCap(process.env['NODE_OPTIONS'], cap);
  console.log(`▶ next build --webpack, NODE_OPTIONS="${nodeOptions}"`);

  const mesure = await mesurerCommande('pnpm --filter @nodal-agents/web build', {
    cwd: repoRoot,
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
  });

  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();

  console.log('\n── Mesure ──────────────────────────────────────────────');
  console.log(`commit              ${commit}`);
  console.log(`cap demandé         ${cap} Mo`);
  console.log(
    `sortie              ${mesure.codeSortie === 0 ? 'succès' : `ÉCHEC (code ${mesure.codeSortie})`}`,
  );
  console.log(`durée               ${mesure.secondes} s`);
  if (mesure.relevesUtiles) {
    console.log(`pic d'un processus  ${mesure.picProcessusMo} Mo (pid ${mesure.pidPic})`);
    console.log(`pic de l'arbre      ${mesure.picArbreMo} Mo (à t+${mesure.tPicArbre} s)`);
    console.log(`relevés utiles      ${mesure.relevesUtiles}`);
    console.log(`plancher justifié   ${plancherPour(mesure.picProcessusMo)} Mo (pic + 25 %)`);
  } else {
    // Un pic de zéro ressemble à un build sobre. On dit l'absence, pas le zéro.
    console.log("pic                 NON MESURÉ — aucun relevé n'a vu de processus");
  }
  console.log(`plancher en vigueur ${plancher} Mo`);
  console.log('────────────────────────────────────────────────────────');

  const iJson = args.indexOf('--json');
  if (iJson !== -1) {
    writeFileSync(
      args[iJson + 1],
      JSON.stringify({ commit, capMo: cap, plancherMo: plancher, ...mesure }, null, 2),
    );
    console.log(`Série complète écrite dans ${args[iJson + 1]}`);
  }

  if (args.includes('--enregistrer')) {
    if (mesure.codeSortie !== 0) {
      // Enregistrer le pic d'un build qui a échoué donnerait une référence
      // basse — le build s'est arrêté avant d'avoir tout demandé — et le
      // prochain build crierait à la hausse sans raison.
      console.log("Référence NON écrite : le build a échoué, son pic ne décrit rien d'entier.");
    } else if (!mesure.relevesUtiles) {
      console.log("Référence NON écrite : le pic n'a pas été mesuré.");
    } else {
      writeFileSync(
        resolve(repoRoot, 'scripts/build-heap-reference.json'),
        JSON.stringify(referenceDepuis(mesure, { commit, cap }), null, 2) + '\n',
      );
      console.log('Référence écrite dans scripts/build-heap-reference.json');
    }
  }

  process.exit(mesure.codeSortie === 0 ? 0 : 1);
}

// Importé par le test, il ne doit rien lancer.
if (process.argv[1] && process.argv[1].endsWith('measure-web-build-heap.mjs')) {
  principal().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
