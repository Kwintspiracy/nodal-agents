// host-container-kill.test.ts — le kill d'une commande ne vise que la commande
// qui tourne encore (#841).
//
// Le pid qu'une commande a reçu de l'hôte reste dans le conteneur après sa fin.
// Un kill demandé ensuite (un Stop, un délai qui tombe juste après la sortie)
// lançait `taskkill /T` sur ce pid : sous Windows, un pid libéré est vite
// redonné, et l'arbre visé était alors celui d'un autre processus de la
// machine. Ce que le test lit : les signaux réellement partis — la ligne de
// `taskkill` sous Windows, le `kill` de groupe ailleurs — pour une commande qui
// tourne, puis pour une commande finie.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const sent = vi.hoisted(() => ({ taskkill: [] as string[][] }));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: (file: string, args: readonly string[]) => {
      if (file !== 'taskkill') throw new Error(`unexpected spawn: ${file}`);
      sent.taskkill.push([...args]);
      const tk = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      tk.stderr = new EventEmitter();
      setImmediate(() => tk.emit('close', 0));
      return tk;
    },
  };
});

const { HostJobContainer } = await import('../host-container');
import type { HostChannel } from '../host-container';

const COMMAND_PID = 4242;

function fakeHost(): { channel: HostChannel; say: (m: unknown) => void; runs: () => number[] } {
  let listener: (chunk: string) => void = () => undefined;
  const written: string[] = [];
  const channel: HostChannel = {
    pid: 1,
    exited: new Promise(() => undefined),
    write: (data) => {
      written.push(data);
    },
    onOutput: (l) => {
      listener = l;
    },
    kill: () => undefined,
  };
  return {
    channel,
    say: (m) => listener(`${JSON.stringify(m)}\n`),
    runs: () =>
      written
        .map((w) => JSON.parse(w) as { op: string; id: number })
        .filter((m) => m.op === 'run')
        .map((m) => m.id),
  };
}

const LAUNCH = { target: { command: 'echo x' }, cwd: '.', env: { PATH: '' } } as const;

let groupKills: Array<[number, unknown]>;

beforeEach(() => {
  sent.taskkill.length = 0;
  groupKills = [];
  // Rien ne part vraiment : 4242 n'est pas à nous.
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: unknown) => {
    groupKills.push([pid, signal]);
    return true;
  }) as typeof process.kill);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Les signaux partis vers la commande, quel que soit l'OS. */
function signalsToCommand(): string[] {
  return [
    ...sent.taskkill.filter((a) => a.includes(String(COMMAND_PID))).map((a) => a.join(' ')),
    ...groupKills.filter(([p]) => Math.abs(p) === COMMAND_PID).map(([p, s]) => `${p} ${String(s)}`),
  ];
}

describe('HostJobContainer: a kill reaches only a command still running (#841)', () => {
  it('a running command is killed with its tree', async () => {
    const host = fakeHost();
    const container = new HostJobContainer(host.channel);
    const proc = await container.start(LAUNCH);
    const [id] = host.runs();
    host.say({ id, started: COMMAND_PID });
    proc.kill();
    await new Promise((r) => setImmediate(r));
    expect(signalsToCommand()).toEqual(
      process.platform === 'win32' ? [`/PID ${COMMAND_PID} /T /F`] : [`-${COMMAND_PID} SIGKILL`],
    );
  });

  it('a command that has exited is sent nothing: its pid may be someone else’s now', async () => {
    const host = fakeHost();
    const container = new HostJobContainer(host.channel);
    const proc = await container.start(LAUNCH);
    const [id] = host.runs();
    host.say({ id, started: COMMAND_PID });
    host.say({ id, exit: 0 });
    expect(await proc.done).toEqual({ kind: 'exit', exitCode: 0 });
    proc.kill();
    await new Promise((r) => setImmediate(r));
    expect(signalsToCommand()).toEqual([]);
  });
});
