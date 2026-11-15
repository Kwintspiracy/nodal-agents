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
// La commande hérite des entrées-sorties ; son code de sortie est rendu tel
// quel (128 + n pour un signal). À la fin : le bilan (pics), et les lignes du
// noyau qui parlent de mémoire ou de tâche bloquée.
//
// Coût : un relevé lit /proc (quelques millisecondes) ; à 5 s, environ 300
// octets par relevé, soit 36 Ko pour 10 minutes.

import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import {
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

const ticsParSec = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
const taillePage = Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim());

/** Une ligne : sur la sortie de l'étape, et ajoutée au fichier tout de suite. */
function ecrire(texte) {
  process.stdout.write(`${texte}\n`);
  appendFileSync(sortie, `${texte}\n`);
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

const debut = Date.now();
const releves = [];
const seuilsDejaFranchis = new Set();
let precedent = null;
function relever() {
  const maintenant = Date.now();
  const r = releverMachine(precedent, { ticsParSec, taillePage, maintenantMs: maintenant });
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

ecrire(`[machine] ${new Date(debut).toISOString()} start: ${commande.join(' ')}`);
const hote = identite();
ecrire(hote);
annoncer('notice', 'machine-trace: host', hote);
relever();
const minuterie = setInterval(relever, pasSec * 1000);

const enfant = spawn(commande[0], commande.slice(1), { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    ecrire(`[machine] ${sig} received, forwarded to the command`);
    // L'état de la machine AU MOMENT où le runner arrête l'étape : c'est la
    // ligne qui manquait à chaque runner perdu.
    annoncer('warning', `machine-trace: ${sig} received`, relever());
    enfant.kill(sig);
  });
}

/** Les lignes du noyau qui disent OOM, mémoire, ou tâche bloquée. Illisibles : dit. */
function noyau() {
  try {
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
  } catch (err) {
    return [`(kernel log unreadable: ${String(err.message).split('\n')[0]})`];
  }
}

enfant.on('error', (err) => {
  clearInterval(minuterie);
  ecrire(`[machine] the command could not start: ${err.message}`);
  process.exit(127);
});

enfant.on('exit', (code, signal) => {
  clearInterval(minuterie);
  relever();
  const resume = bilan(releves);
  ecrire(resume);
  annoncer('notice', 'machine-trace: summary', resume);
  for (const l of noyau()) ecrire(`[machine] kernel: ${l}`);
  const rendu = code ?? 128 + ({ SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }[signal] ?? 1);
  ecrire(
    `[machine] command ended (${signal ? `signal ${signal}` : `exit ${code}`}) after ${Math.round((Date.now() - debut) / 1000)}s`,
  );
  process.exit(rendu);
});
