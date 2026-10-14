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
// (`UV_THREADPOOL_SIZE`). Il ne fait que trois choses : ouvrir un conteneur
// (le SDK, `spawn`), le tuer, dire quand il s'est arrêté. Les commandes, elles,
// ne passent pas par lui : l'hôte du conteneur joint le runner directement
// (job-host.ts). Le runner mort, l'entrée du courtier se ferme ; il tue alors
// ses conteneurs et s'arrête.
//
// Protocole, une ligne JSON par message, sur l'entrée et la sortie standard
// du courtier :
//   runner → courtier  {op:'open', id, request}  |  {op:'kill', id}
//   courtier → runner  {id, opened, pid} | {id, error} | {id, exited, output}

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContainerRequest } from '@microsoft/mxc-sdk/v1';
import { sandboxHostDir } from './job-host';
import { SandboxStartError } from './types';

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
  for (const p of procs.values()) { try { p.kill(); } catch {} }
  setTimeout(() => process.exit(0), 500);
});
async function handle(m) {
  if (m.op === 'kill') {
    const p = procs.get(m.id);
    if (p) { try { p.kill(); } catch {} }
    return;
  }
  if (m.op !== 'open') return;
  let p;
  try {
    const s = await load();
    p = await s.spawn(m.request, { telemetry: { enabled: false } });
  } catch (e) {
    out({ id: m.id, error: (e && typeof e.code === 'string' ? e.code + ': ' : '') + String((e && e.message) || e) });
    return;
  }
  procs.set(m.id, p);
  let output = '';
  const keep = (d) => { output = (output + String(d)).slice(-2000); };
  if (p.standardOutput) p.standardOutput.on('data', keep);
  if (p.standardError) p.standardError.on('data', keep);
  out({ id: m.id, opened: true, pid: p.id });
  p.wait().then((w) => w.exitCode, () => null).then((code) => {
    procs.delete(m.id);
    out({ id: m.id, exited: code, output });
    try { p.dispose(); } catch {}
  });
}
`;

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
  /** Résolue quand le conteneur s'est arrêté, avec ce que sa racine a écrit. */
  readonly exited: Promise<{ code: number | null; output: string }>;
  kill(): void;
}

interface Pending {
  open?: { resolve: (c: BrokeredContainer) => void; reject: (e: Error) => void };
  exit: (r: { code: number | null; output: string }) => void;
  exited: Promise<{ code: number | null; output: string }>;
}

/** Le client du courtier, côté runner. Un par processus, relancé s'il meurt. */
export class MxcBroker {
  private child: ChildProcess | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

  /** `resolveFrom` : le fichier depuis lequel le courtier résout le SDK. */
  constructor(private readonly resolveFrom: string) {}

  private start(): ChildProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const child = spawn(process.execPath, [ensureBrokerScript(), this.resolveFrom], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, UV_THREADPOOL_SIZE: String(BROKER_THREADPOOL_SIZE) },
    });
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
    child.on('exit', () => {
      if (this.child === child) this.child = null;
      // Le courtier mort, ses conteneurs sont morts avec lui.
      const why = `SANDBOX_BROKER_EXITED${stderr.trim() ? `: ${stderr.trim()}` : ''}`;
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        p.open?.reject(new SandboxStartError(why));
        p.exit({ code: null, output: why });
      }
    });
    child.on('error', () => undefined);
    // Le runner ne reste pas en vie pour son courtier.
    child.unref();
    (child.stdout as unknown as { unref?: () => void } | null)?.unref?.();
    (child.stderr as unknown as { unref?: () => void } | null)?.unref?.();
    (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    this.child = child;
    return child;
  }

  private handle(m: BrokerMessage): void {
    const p = this.pending.get(m.id);
    if (!p) return;
    if (m.error !== undefined) {
      this.pending.delete(m.id);
      p.open?.reject(new SandboxStartError(m.error));
      p.exit({ code: null, output: m.error });
    } else if (m.opened) {
      const open = p.open;
      p.open = undefined;
      const id = m.id;
      open?.resolve({
        pid: m.pid ?? 0,
        exited: p.exited,
        kill: () => this.send({ op: 'kill', id }),
      });
    } else if ('exited' in m) {
      this.pending.delete(m.id);
      p.exit({ code: m.exited ?? null, output: m.output ?? '' });
    }
  }

  private send(message: unknown): void {
    this.start().stdin?.write(`${JSON.stringify(message)}\n`);
  }

  /** Ouvre un conteneur ; lève `SandboxStartError` avec la raison du SDK. */
  open(request: ContainerRequest): Promise<BrokeredContainer> {
    const id = ++this.nextId;
    let exit!: Pending['exit'];
    const exited = new Promise<{ code: number | null; output: string }>((r) => (exit = r));
    return new Promise<BrokeredContainer>((resolve, reject) => {
      this.pending.set(id, { open: { resolve, reject }, exit, exited });
      this.send({ op: 'open', id, request });
    });
  }
}

interface BrokerMessage {
  id: number;
  opened?: boolean;
  pid?: number;
  error?: string;
  exited?: number | null;
  output?: string;
}
