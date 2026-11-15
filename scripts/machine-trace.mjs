#!/usr/bin/env node
// machine-trace.mjs — lance une commande et relève la machine pendant qu'elle tourne.
//
//   node scripts/machine-trace.mjs --out <fichier> [--every 5] -- <commande> [args…]
//
// Chaque relevé (voir lib/machine-trace.mjs) est écrit AU MOMENT où il est pris,
// sur la sortie de l'étape ET à la fin de `--out` : si le runner meurt au
// milieu, le journal du job (quand GitHub le garde) et le fichier (quand
// l'artefact part) s'arrêtent sur l'état de la machine dans ses dernières
// secondes. Le fichier s'allonge d'une étape à l'autre : les deux étapes qui
// l'utilisent dans `ci.yml` (démarrage de la stack, parcours) s'y suivent.
//
// LA TRACE OBSERVE, ELLE NE DÉCIDE JAMAIS (revue de la PR #1107). La commande
// démarre AVANT toute partie de la trace ; son code de sortie est rendu tel
// quel (128 + n pour un signal) et c'est le seul verdict de l'étape. Chaque
// partie de la trace (getconf, en-tête, relevé, fichier, noyau, bilan) passe par
// `gardien` : sa première panne est dite une fois, puis la trace s'arrête.
//
// La trace n'écrit jamais un argument de la commande : le journal et
// l'artefact ne sont pas masqués par GitHub. Elle écrit le programme et le
// nombre d'arguments.
//
// Coût : un relevé lit /proc (quelques millisecondes) ; à 5 s, environ 300
// octets par relevé, soit 36 Ko pour 10 minutes.

import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  gardien,
  identite,
  releverMachine,
  ligne,
  bilan,
  seuilsFranchis,
  annotation,
} from './lib/machine-trace.mjs';

if (process.platform !== 'linux') {
  console.error('machine-trace: Linux only (it reads /proc and /sys)');
  process.exit(2);
}

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const options = sep < 0 ? argv : argv.slice(0, sep);
const commande = sep < 0 ? [] : argv.slice(sep + 1);
const opt = (nom) => {
  const i = options.indexOf(nom);
  return i < 0 ? undefined : options[i + 1];
};
const sortie = opt('--out');
const pasSec = Number(opt('--every') ?? '5');
if (!sortie || commande.length === 0 || !Number.isFinite(pasSec) || pasSec <= 0) {
  console.error(
    'usage: node scripts/machine-trace.mjs --out <file> [--every <seconds>] -- <command> [args...]',
  );
  process.exit(2);
}

/**
 * Une annotation (voir lib/machine-trace.mjs : c'est ce qui arrive au serveur
 * même quand le runner est perdu). Précédée d'un saut de ligne : la sortie de
 * Playwright écrit ses points sans retour, et une commande doit commencer sa
 * ligne pour être lue.
 */
function annoncer(genre, titre, texte) {
  process.stdout.write(`\n${annotation(genre, titre, texte)}\n`);
}

// La panne de la trace va au journal et en annotation, JAMAIS dans `--out` :
// c'est peut-être lui qui vient de lâcher.
let minuterie = null;
const trace = gardien((texte) => {
  if (minuterie) clearInterval(minuterie);
  process.stdout.write(`${texte}\n`);
  annoncer('warning', 'machine-trace: trace stopped', texte);
});

/** Une ligne : sur la sortie de l'étape, et ajoutée au fichier tout de suite. */
function ecrire(texte) {
  process.stdout.write(`${texte}\n`);
  appendFileSync(sortie, `${texte}\n`);
}

// ── La commande d'abord : rien de la trace ne passe avant elle ───────────────
const debut = Date.now();
const enfant = spawn(commande[0], commande.slice(1), { stdio: 'inherit' });

// ── Puis la trace, partie par partie ─────────────────────────────────────────
const releves = [];
const seuilsDejaFranchis = new Set();
let precedent = null;
let mesure = null;

function relever() {
  const maintenant = Date.now();
  const r = releverMachine(precedent, { ...mesure, maintenantMs: maintenant });
  r.depuisSec = Math.round((maintenant - debut) / 1000);
  // Les processus ne servent qu'au relevé suivant (CPU) : ne pas les garder tous.
  if (precedent) delete precedent.procs;
  precedent = r;
  releves.push(r);
  const texte = ligne(r, {
    depuisSec: r.depuisSec,
    heure: new Date(maintenant).toISOString().slice(11, 19),
  });
  ecrire(texte);
  const franchis = seuilsFranchis(r.mem.disponible, seuilsDejaFranchis);
  for (const s of franchis) seuilsDejaFranchis.add(s);
  if (franchis.length > 0) {
    annoncer('warning', `machine-trace: available memory under ${franchis.at(-1)} GB`, texte);
  }
  if (r.debits.oomKill > 0) {
    annoncer('warning', 'machine-trace: the kernel killed a process (OOM)', texte);
  }
  return texte;
}

mesure = trace.essayer('getconf', () => {
  const lire = (nom) => {
    const v = Number(execFileSync('getconf', [nom], { encoding: 'utf8' }).trim());
    if (!Number.isFinite(v) || v <= 0) throw new Error(`getconf ${nom} gave "${v}"`);
    return v;
  };
  return { ticsParSec: lire('CLK_TCK'), taillePage: lire('PAGESIZE') };
});
trace.essayer('the header', () => {
  ecrire(
    `[machine] ${new Date(debut).toISOString()} start: ${basename(commande[0])} with ${commande.length - 1} arguments`,
  );
  const hote = identite();
  ecrire(hote);
  annoncer('notice', 'machine-trace: host', hote);
});
trace.essayer('a sample', relever);
if (!trace.panne) minuterie = setInterval(() => trace.essayer('a sample', relever), pasSec * 1000);

// Le transfert des signaux est le travail du lanceur, pas de la trace : il a
// lieu même quand la trace est arrêtée.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    // L'état de la machine AU MOMENT où le runner arrête l'étape : c'est la
    // ligne qui manquait à chaque runner perdu.
    trace.essayer('the sample at the signal', () => {
      ecrire(`[machine] ${sig} received, forwarded to the command`);
      annoncer('warning', `machine-trace: ${sig} received`, relever());
    });
    enfant.kill(sig);
  });
}

/** Les lignes du noyau qui disent OOM, mémoire, ou tâche bloquée. */
function noyau() {
  const texte = execFileSync('sudo', ['-n', 'dmesg', '-T'], {
    encoding: 'utf8',
    maxBuffer: 32e6,
  });
  const utiles = texte
    .split('\n')
    .filter((l) => /out of memory|oom|killed process|blocked for more than|hung_task/i.test(l));
  return utiles.length
    ? utiles.slice(-20)
    : ['(no OOM, memory or hung-task line in the kernel log)'];
}

enfant.on('error', (err) => {
  if (minuterie) clearInterval(minuterie);
  process.stdout.write(`[machine] the command could not start: ${err.message}\n`);
  process.exit(127);
});

enfant.on('exit', (code, signal) => {
  if (minuterie) clearInterval(minuterie);
  trace.essayer('the last sample', relever);
  trace.essayer('the summary', () => {
    const resume = bilan(releves);
    ecrire(resume);
    annoncer('notice', 'machine-trace: summary', resume);
  });
  const fin = `[machine] command ended (${signal ? `signal ${signal}` : `exit ${code}`}) after ${Math.round((Date.now() - debut) / 1000)}s`;
  trace.essayer('the end line', () => ecrire(fin));
  trace.essayer('the kernel log', () => {
    for (const l of noyau()) ecrire(`[machine] kernel: ${l}`);
  });
  process.exit(code ?? 128 + ({ SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }[signal] ?? 1));
});
