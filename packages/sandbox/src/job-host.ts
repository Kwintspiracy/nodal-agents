// job-host.ts — l'HÔTE d'un conteneur de job (#628, décision du 14/10).
//
// Un processus d'arrière-plan qu'une commande laisse tourner (un serveur de
// dev, ComfyUI, `start /b …`) doit vivre jusqu'à la FIN DU JOB, pour que les
// commandes suivantes du même job le joignent. Or MXC détruit son conteneur
// — et tout ce qui y tourne — quand son processus racine se termine, et son
// API de cycle de vie (provision / start / exec) n'existe pas pour le
// conteneur de processus (seulement `isolation_session` et `wslc`, voir
// `LifecycleContainmentKind` du SDK 1.0.0).
//
// D'où cet hôte : un petit programme Node lancé UNE fois par job dans un
// conteneur MXC, qui lance chaque commande du job comme son enfant — donc
// dans le même conteneur, sous le même confinement. Le conteneur vit tant que
// l'hôte vit ; le runner le ferme à la fin du job, et tout ce qui y tourne
// meurt avec lui. Mesuré le 14/10 (Windows 11 Home 25H2) : la commande 2
// joint le serveur que la commande 1 a lancé par `start /b` ; une écriture
// hors des dossiers permis est refusée ; ~80 ms par commande (contre ~160 ms
// pour un conteneur par commande) ; le serveur meurt quand le conteneur est
// tué, ET quand le processus qui le tient se termine.
//
// LE CANAL est une connexion TCP sur la boucle locale, que l'hôte ouvre vers
// le runner — pas l'entrée standard de l'hôte. Mesuré le 14/10 : dès qu'un
// SECOND conteneur est lancé par le même runner, ce qu'on écrit sur l'entrée
// standard du premier (le flux natif du SDK MXC 1.0.0) ne lui parvient plus,
// et ses commandes restent sans réponse jusqu'à ce que l'autre se ferme. La
// boucle locale, elle, répond depuis le conteneur avec la seule règle
// `egress allow`. Le runner donne à l'hôte un port et un jeton à usage
// unique ; une connexion qui ne présente pas le jeton est fermée.
//
// Le protocole, une ligne JSON par message :
//   hôte → runner  {hello: jeton}           à la connexion ;
//   runner → hôte  {op:'init', env}         l'environnement que Nodal a passé
//                                            à l'hôte : ce que MXC y a remplacé
//                                            (TEMP, TMP, LOCALAPPDATA…) est
//                                            réimposé à chaque commande ;
//                  {op:'run', id, file, argv0, rest, cwd, env}
//   hôte → runner  {ready, pid}
//                  {id, started}            le pid de la commande, pour la tuer
//                                            de l'extérieur (taskkill /T est
//                                            refusé DANS le conteneur, mesuré) ;
//                  {id, s:'o'|'e', d}       sa sortie, en base64 ;
//                  {id, exit, signal} | {id, error}
// La connexion fermée, l'hôte s'arrête — et le conteneur avec lui : un runner
// qui meurt n'en laisse pas derrière lui.
//
// La fin d'une commande est la fin de son processus RACINE, puis ses flux
// vidés au plus DRAIN_MS : un serveur lancé par `start /b` hérite du tuyau de
// sortie et le garde ouvert — attendre sa fermeture retiendrait la commande
// jusqu'à son timeout.
//
// Ce fichier n'importe RIEN du dépôt : sa source est écrite telle quelle sur
// le disque (le bundle du runner n'a pas de fichier à côté de lui).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Délai laissé aux flux d'une commande après la fin de son processus racine. */
export const DRAIN_MS = 200;

export const JOB_HOST_SOURCE = `'use strict';
// Hôte du conteneur d'un job Nodal (@nodal-agents/sandbox, job-host.ts).
const { spawn } = require('child_process');
const net = require('net');
const DRAIN_MS = ${DRAIN_MS};
const up = (k) => k.toUpperCase();
const socket = net.connect(Number(process.argv[2]), '127.0.0.1');
const out = (o) => socket.write(JSON.stringify(o) + '\\n');
let overrides = {};
let buffer = '';
socket.setEncoding('utf8');
// Une panne de l'hôte se dit sur la connexion : ses sorties standard sont
// fermées dès qu'elle est établie (voir plus bas).
process.on('uncaughtException', (e) => {
  try { out({ fatal: String((e && e.stack) || e) }); } catch {}
  setTimeout(() => process.exit(1), 50);
});
socket.on('connect', () => {
  out({ hello: process.argv[3] });
  // Le SDK lit les sorties standard d'un processus confiné par des lectures
  // BLOQUANTES du pool de threads de Node (4 threads par défaut) : un hôte
  // qui les garderait ouvertes immobiliserait deux threads du runner pour
  // toute la durée du job, et deux jobs suffiraient à geler toutes ses
  // lectures de fichiers. Fermées, ces lectures finissent aussitôt.
  try { process.stdout.destroy(); } catch {}
  try { process.stderr.destroy(); } catch {}
});
socket.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.op === 'init') {
      const passed = {};
      for (const [k, v] of Object.entries(m.env)) passed[up(k)] = v;
      overrides = {};
      for (const [k, v] of Object.entries(process.env)) if (passed[up(k)] !== v) overrides[k] = v;
      out({ ready: true, pid: process.pid });
    } else if (m.op === 'run') {
      run(m);
    }
  }
});
socket.on('close', () => process.exit(0));
socket.on('error', () => process.exit(1));
function run(m) {
  const replaced = new Set(Object.keys(overrides).map(up));
  const env = {};
  for (const [k, v] of Object.entries(m.env)) if (v !== null && v !== undefined && !replaced.has(up(k))) env[k] = v;
  Object.assign(env, overrides);
  let finished = false;
  const finish = (o) => { if (finished) return; finished = true; out(Object.assign({ id: m.id }, o)); };
  let child;
  try {
    child = spawn(m.file, m.rest === '' ? [] : [m.rest], {
      argv0: m.argv0, windowsVerbatimArguments: true, cwd: m.cwd, env,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
  } catch (e) {
    finish({ error: String((e && e.message) || e) });
    return;
  }
  child.on('spawn', () => out({ id: m.id, started: child.pid }));
  child.stdout.on('data', (d) => { if (!finished) out({ id: m.id, s: 'o', d: d.toString('base64') }); });
  child.stderr.on('data', (d) => { if (!finished) out({ id: m.id, s: 'e', d: d.toString('base64') }); });
  child.on('error', (e) => finish({ error: e.message }));
  child.on('exit', (code, signal) => {
    const t = setTimeout(() => finish({ exit: code, signal: signal }), DRAIN_MS);
    child.once('close', () => { clearTimeout(t); finish({ exit: code, signal: signal }); });
  });
}
`;

/**
 * Le dossier où Nodal pose l'hôte. Lisible par le conteneur (les lecteurs le
 * sont) ; surchargeable pour les tests, comme les autres dossiers de Nodal.
 */
export function sandboxHostDir(): string {
  return process.env['NODALAI_SANDBOX_DIR'] ?? join(homedir(), '.nodalai', 'sandbox');
}

/**
 * Le chemin du script de l'hôte, écrit s'il manque ou s'il ne dit pas
 * exactement `JOB_HOST_SOURCE` : son nom porte l'empreinte de son contenu,
 * et un fichier modifié est réécrit avant d'être lancé.
 */
export function ensureJobHostScript(dir: string = sandboxHostDir()): string {
  const digest = createHash('sha256').update(JOB_HOST_SOURCE).digest('hex').slice(0, 16);
  const path = join(dir, `job-host-${digest}.cjs`);
  let current: string | null = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = null;
  }
  if (current !== JOB_HOST_SOURCE) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JOB_HOST_SOURCE, 'utf8');
  }
  return path;
}
