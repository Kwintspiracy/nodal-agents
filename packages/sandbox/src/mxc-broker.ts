// mxc-broker.ts — le processus qui TIENT les conteneurs MXC, à côté du runner.
//
// MESURÉ le 14/10 (SDK MXC 1.0.0, Node 26.11, Windows 11 Home) : sous
// Windows, le SDK lit les sorties standard d'un processus confiné par
// `fs.createReadStream` sur le handle natif — des lectures BLOQUANTES du pool
// de threads de Node, deux par conteneur ouvert ; `run()` en immobilise un
// par conteneur. Le pool compte 4 threads par défaut : avec deux conteneurs
// vivants, toute lecture de fichier asynchrone du processus qui les tient
// attendait la fermeture de l'un d'eux (un `readFile` de 5 s, un
// troisième conteneur jamais ouvert). Dans le runner, c'est le runner entier
// qui se figeait — base, journaux, livraisons.
//
// D'où ce courtier : un petit processus Node, NON confiné, lancé une fois par
// le runner, qui seul appelle le SDK, avec un pool de threads à sa mesure
// (`UV_THREADPOOL_SIZE`). Il ouvre un conteneur (le SDK, `spawn`), le tue,
// dit quand il s'est arrêté, et RELAIE le canal de son hôte : ce que le runner
// écrit à l'hôte va sur l'entrée standard du conteneur, ce que l'hôte écrit
// sur sa sortie standard revient au runner (job-host.ts dit pourquoi ce canal
// plutôt que le réseau). Le runner mort, l'entrée du courtier se ferme ; il
// tue alors ses conteneurs et s'arrête.
//
// Protocole, une ligne JSON par message, sur l'entrée et la sortie standard
// du courtier :
//   runner → courtier  {op:'open', id, request} | {op:'write', id, data}
//                      | {op:'kill', id}
//   courtier → runner  {id, opened, pid} | {id, error: {code, message, remediation}}
//                      | {id, o}  (ce que l'hôte a écrit sur sa sortie standard)
//                      | {id, exited, output}  (output : la fin de sa sortie
//                        d'erreur, où Node écrit une panne au démarrage)

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContainerRequest } from '@microsoft/mxc-sdk/v1';
import { sandboxHostDir } from './job-host';
import { BrokerNodeUnavailable, verifyPinnedNodeSync } from './broker-node';
import { SandboxStartError, type SandboxUnavailableCode } from './types';

/**
 * Taille du pool de threads du courtier : deux lectures bloquantes par
 * conteneur vivant, donc ~60 conteneurs simultanés, très au-delà des jobs
 * concurrents d'un runner.
 */
export const BROKER_THREADPOOL_SIZE = 128;

export const MXC_BROKER_SOURCE = `'use strict';
// Courtier MXC de Nodal (@nodal-agents/sandbox, mxc-broker.ts).
const { pathToFileURL } = require('url');
const { createRequire } = require('module');
// Le SDK est résolu depuis le module du runner qui a lancé ce courtier.
const sdkPath = createRequire(process.argv[2]).resolve('@microsoft/mxc-sdk/v1');
let sdk = null;
const procs = new Map();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const load = async () => (sdk = sdk || (await import(pathToFileURL(sdkPath).href)));
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    void handle(m);
  }
});
process.stdin.on('end', () => {
  for (const c of procs.values()) { try { c.p.kill(); } catch {} }
  setTimeout(() => process.exit(0), 500);
});
async function handle(m) {
  if (m.op === 'kill') {
    const c = procs.get(m.id);
    if (c) { try { c.p.kill(); } catch {} }
    return;
  }
  if (m.op === 'write') {
    const c = procs.get(m.id);
    if (c && c.stdin) { try { c.stdin.write(m.data); } catch {} }
    return;
  }
  if (m.op !== 'open') return;
  let p;
  try {
    const s = await load();
    p = await s.spawn(m.request, { telemetry: { enabled: false } });
  } catch (e) {
    // L'erreur du SDK telle quelle, champs séparés : le runner la met en
    // texte (mxcErrorText), remédiation comprise.
    out({ id: m.id, error: { code: e && e.code, message: String((e && e.message) || e), remediation: e && e.remediation } });
    return;
  }
  // L'entrée de l'hôte est PRISE avant wait() : le SDK ferme une entrée que
  // personne n'a prise quand on attend la fin du processus (wait(),
  // container-process.js) — l'hôte lirait aussitôt la fin de son entrée.
  const stdin = p.standardInput;
  procs.set(m.id, { p, stdin });
  let output = '';
  if (p.standardOutput) {
    p.standardOutput.setEncoding('utf8');
    p.standardOutput.on('data', (d) => out({ id: m.id, o: d }));
  }
  if (p.standardError) {
    p.standardError.setEncoding('utf8');
    p.standardError.on('data', (d) => { output = (output + d).slice(-2000); });
  }
  out({ id: m.id, opened: true, pid: p.id });
  p.wait().then((w) => w.exitCode, () => null).then((code) => {
    procs.delete(m.id);
    out({ id: m.id, exited: code, output });
    try { p.dispose(); } catch {}
  });
}
`;

/** Les champs d'une erreur du SDK MXC (`MxcError`) qui disent quoi et que faire. */
export interface MxcErrorFields {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly remediation?: unknown;
}

/**
 * Le texte d'une erreur du SDK MXC, le même qu'elle vienne du courtier ou du
 * runner : `code: message`, puis la REMÉDIATION que MXC donne quand il en
 * donne une. C'est elle qui dit à l'utilisateur quoi faire — pour un Node trop
 * ancien, MXC nomme la version courante dans le message et les versions à
 * installer dans la remédiation (`Use Node.js 24.21.0 or newer within Node.js
 * 24, or Node.js 26.8.0 or newer on Windows.`).
 */
export function mxcErrorText(e: MxcErrorFields): string {
  const message = typeof e.message === 'string' ? e.message : String(e.message);
  const head = typeof e.code === 'string' ? `${e.code}: ${message}` : message;
  return typeof e.remediation === 'string' && e.remediation.trim()
    ? `${head}. ${e.remediation.trim()}`
    : head;
}

/** Le script du courtier, écrit s'il manque ou diffère (même règle que l'hôte). */
function ensureBrokerScript(dir: string = sandboxHostDir()): string {
  const digest = createHash('sha256').update(MXC_BROKER_SOURCE).digest('hex').slice(0, 16);
  const path = join(dir, `mxc-broker-${digest}.cjs`);
  let current: string | null = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = null;
  }
  if (current !== MXC_BROKER_SOURCE) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, MXC_BROKER_SOURCE, 'utf8');
  }
  return path;
}

/** Un conteneur ouvert par le courtier. */
export interface BrokeredContainer {
  /** Le pid du processus racine du conteneur (l'hôte). */
  readonly pid: number;
  /** Résolue quand le conteneur s'est arrêté, avec la fin de sa sortie d'erreur. */
  readonly exited: Promise<{ code: number | null; output: string }>;
  /** Écrit sur l'entrée standard de l'hôte. */
  write(data: string): void;
  /** Ce que l'hôte écrit sur sa sortie standard, dans l'ordre, rien de perdu. */
  onOutput(listener: (chunk: string) => void): void;
  kill(): void;
}

interface Pending {
  open?: { resolve: (c: BrokeredContainer) => void; reject: (e: Error) => void };
  exit: (r: { code: number | null; output: string }) => void;
  exited: Promise<{ code: number | null; output: string }>;
  /** Sortie de l'hôte arrivée avant qu'on l'écoute ; vidée au premier écouteur. */
  early: string[];
  listener?: (chunk: string) => void;
}

/** Le client du courtier, côté runner. Un par processus, relancé s'il meurt. */
export class MxcBroker {
  private child: ChildProcess | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

  /**
   * `resolveFrom` : le fichier depuis lequel le courtier résout le SDK.
   * `nodePath` : le Node qui fait tourner le courtier.
   * `expectedSha256` : la somme épinglée de ce Node, vérifiée À CHAQUE
   * lancement (#628, P1-2) ; absente seulement pour un Node fixe de test.
   */
  constructor(
    private readonly resolveFrom: string,
    private readonly nodePath: string = process.execPath,
    private readonly expectedSha256?: string,
  ) {}

  /** Le courtier vivant, ou `null` — sans jamais en lancer un. */
  private live(): ChildProcess | null {
    const c = this.child;
    return c && c.exitCode === null && !c.killed ? c : null;
  }

  /**
   * Le courtier vivant, ou un courtier NEUF. Le seul endroit qui lance un
   * processus hors conteneur : la somme du Node y est vérifiée d'abord. Une
   * somme fausse rejette ce qui attend (code SANDBOX_BROKER_NODE_UNAVAILABLE)
   * et ne lance rien.
   */
  private start(): ChildProcess | null {
    const alive = this.live();
    if (alive) return alive;
    if (this.expectedSha256 !== undefined) {
      try {
        verifyPinnedNodeSync(this.nodePath, this.expectedSha256);
      } catch (e) {
        if (!(e instanceof BrokerNodeUnavailable)) throw e;
        this.rejectPending(e.message, e.code);
        return null;
      }
    }
    let child: ChildProcess;
    try {
      child = spawn(this.nodePath, [ensureBrokerScript(), this.resolveFrom], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, UV_THREADPOOL_SIZE: String(BROKER_THREADPOOL_SIZE) },
      });
    } catch (e) {
      // `spawn` peut lever TOUT DE SUITE (Windows : `spawn UNKNOWN` sur un
      // binaire qui n'est pas un exécutable) au lieu d'émettre `error` : même
      // règlement, même code — rien ne reste en attente.
      const err = e as NodeJS.ErrnoException;
      this.rejectPending(
        `SANDBOX_BROKER_START_FAILED: ${err.code ? `${err.code} ` : ''}${err.message}`,
        'SANDBOX_BROKER_START_FAILED',
      );
      return null;
    }
    let buffer = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          this.handle(JSON.parse(line) as BrokerMessage);
        } catch {
          /* ligne illisible : ignorée */
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2_000);
    });
    // Le courtier mort, ou jamais lancé : UN seul chemin règle tout ce qui
    // l'attend (ouvertures, fins de conteneur — donc les commandes et les
    // fermetures qui attendent ces fins). Rien ne reste en attente.
    child.on('exit', () => {
      this.failAll(child, `SANDBOX_BROKER_EXITED${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      this.failAll(
        child,
        `SANDBOX_BROKER_START_FAILED: ${e.code ? `${e.code} ` : ''}${e.message}`,
        'SANDBOX_BROKER_START_FAILED',
      );
    });
    // Une écriture vers un courtier mort (EPIPE) se règle par `exit` / `error`.
    child.stdin?.on('error', () => undefined);
    // Le runner ne reste pas en vie pour son courtier sans conteneur : voir hold().
    (child.stderr as unknown as { unref?: () => void } | null)?.unref?.();
    (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    this.child = child;
    this.hold();
    return child;
  }

  /**
   * Le courtier `child` ne servira plus : chaque demande en attente est rejetée
   * et chaque conteneur ouvert se dit fini, avec `why` ; la demande suivante
   * relance un courtier neuf au lieu d'écrire à celui-ci.
   */
  private failAll(child: ChildProcess, why: string, reasonCode?: SandboxUnavailableCode): void {
    if (this.child === child) this.child = null;
    this.rejectPending(why, reasonCode);
    this.hold();
  }

  /** Chaque demande en attente est rejetée, chaque conteneur se dit fini. */
  private rejectPending(why: string, reasonCode?: SandboxUnavailableCode): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.open?.reject(new SandboxStartError(why, reasonCode));
      p.exit({ code: null, output: why });
    }
  }

  /**
   * Tant qu'un conteneur est ouvert (ou en train de s'ouvrir), le processus qui
   * le tient reste en vie : une commande en cours attend une réponse qui ne
   * vient que par le courtier. Sans conteneur, le courtier ne retient rien —
   * le runner, ou un CLI qui a fini, s'arrête sans lui.
   */
  private hold(): void {
    const child = this.child;
    if (!child) return;
    const out = child.stdout as unknown as { ref?: () => void; unref?: () => void } | null;
    if (this.pending.size > 0) {
      child.ref();
      out?.ref?.();
    } else {
      child.unref();
      out?.unref?.();
    }
  }

  private handle(m: BrokerMessage): void {
    const p = this.pending.get(m.id);
    if (!p) return;
    if (m.error !== undefined) {
      this.pending.delete(m.id);
      this.hold();
      const text = mxcErrorText(m.error);
      p.open?.reject(new SandboxStartError(text));
      p.exit({ code: null, output: text });
    } else if (m.opened) {
      const open = p.open;
      p.open = undefined;
      const id = m.id;
      open?.resolve({
        pid: m.pid ?? 0,
        exited: p.exited,
        // Écrire ou tuer ne LANCE jamais de courtier : si le sien est mort,
        // le conteneur l'est aussi (failAll a réglé sa fin), il n'y a
        // personne à qui parler.
        write: (data) => this.post({ op: 'write', id, data }),
        onOutput: (listener) => {
          p.listener = listener;
          for (const chunk of p.early.splice(0)) listener(chunk);
        },
        kill: () => this.post({ op: 'kill', id }),
      });
    } else if (m.o !== undefined) {
      if (p.listener) p.listener(m.o);
      else p.early.push(m.o);
    } else if ('exited' in m) {
      this.pending.delete(m.id);
      this.hold();
      p.exit({ code: m.exited ?? null, output: m.output ?? '' });
    }
  }

  /** Un message au courtier VIVANT ; rien si aucun ne l'est. */
  private post(message: unknown): void {
    this.live()?.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  /** Ouvre un conteneur ; lève `SandboxStartError` avec la raison du SDK. */
  open(request: ContainerRequest): Promise<BrokeredContainer> {
    const id = ++this.nextId;
    let exit!: Pending['exit'];
    const exited = new Promise<{ code: number | null; output: string }>((r) => (exit = r));
    return new Promise<BrokeredContainer>((resolve, reject) => {
      this.pending.set(id, { open: { resolve, reject }, exit, exited, early: [] });
      // Seule une ouverture peut LANCER un courtier (start vérifie son Node).
      this.start();
      this.post({ op: 'open', id, request });
      this.hold();
    });
  }
}

interface BrokerMessage {
  id: number;
  opened?: boolean;
  pid?: number;
  error?: MxcErrorFields;
  o?: string;
  exited?: number | null;
  output?: string;
}
