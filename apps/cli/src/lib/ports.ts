// ports.ts — find available ports for services

import { createServer } from 'net';

/**
 * The PID listening on `port`, or null when nothing holds it.
 *
 * Windows-only, through `netstat -ano`. Everywhere else it answers null, which
 * every caller reads as "no measurement", never as "nothing is there" — a port
 * with no pid attributed to it is reported without one rather than next to a
 * configured value (issue #97).
 *
 * Moved here from `up.ts` when the already-running pre-flight needed the same
 * reading: two spellings of one measurement is how the two of them would drift.
 */
export async function pidListeningOnPort(port: number): Promise<number | null> {
  const { execa } = await import('execa');
  try {
    const { stdout } = await execa('netstat', ['-ano'], { reject: false });
    for (const line of stdout.split(/\r?\n/)) {
      // "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       14568"
      const m = line.match(/\s+TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m && m[1] && m[2] && Number.parseInt(m[1], 10) === port) {
        return Number.parseInt(m[2], 10);
      }
    }
  } catch {
    /* ignore — best-effort */
  }
  return null;
}

/**
 * Test whether a port can currently be bound on 127.0.0.1.
 *
 * On Windows, a port can be unbindable not because something is listening
 * but because the OS has reserved it (Hyper-V / WinNAT excluded ranges).
 * `netstat` shows no PID, but `listen()` returns EACCES. That's the case
 * this helper catches: it returns false in both "in use" and "reserved"
 * scenarios, so the caller can rotate to a different port.
 */
export function isPortBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    try {
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(true));
      });
    } catch {
      // listen() can throw synchronously on out-of-range ports (RangeError)
      // before any 'error' event is emitted. Treat that as "not bindable".
      resolve(false);
    }
  });
}

/**
 * Find a free port starting from the given preferred port.
 * Tries preferred, then preferred+1, preferred+2, etc., up to maxAttempts.
 * A port in `reserved` is never answered, free or not: it belongs to another
 * service of the same configuration, which may simply not be started yet.
 */
export function findFreePort(
  preferred: number,
  maxAttempts = 20,
  reserved: ReadonlySet<number> = new Set(),
): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryPort = (port: number): void => {
      if (attempt >= maxAttempts) {
        reject(
          new Error(
            `Could not find a free port after ${maxAttempts} attempts starting at ${preferred}`,
          ),
        );
        return;
      }
      attempt++;
      if (reserved.has(port)) {
        tryPort(port + 1);
        return;
      }
      const server = createServer();
      server.listen(port, '127.0.0.1', () => {
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        server.close(() => resolve(actualPort));
      });
      server.on('error', () => {
        tryPort(port + 1);
      });
    };
    tryPort(preferred);
  });
}

/** The three ports of one configuration. */
export interface ServicePorts {
  readonly web: number;
  readonly runner: number;
  readonly postgres: number;
}

/** How `allocateServicePorts` asks the machine about a port. */
export interface PortProbe {
  readonly bindable: (port: number) => Promise<boolean>;
  readonly freeFrom: (start: number, reserved: ReadonlySet<number>) => Promise<number>;
}

const MACHINE: PortProbe = {
  bindable: isPortBindable,
  freeFrom: (start, reserved) => findFreePort(start, 20, reserved),
};

/**
 * The ports the services start on: each configured one when it can be bound,
 * else the next free one. ONE decision over the set (B38-03, B39-01): a port
 * that another service of this configuration holds or was given is never
 * handed to a second one. Probing one port at a time used to give the web the
 * runner's port, because the runner was not listening yet, and `up` saved it.
 */
export async function allocateServicePorts(
  configured: ServicePorts,
  probe: PortProbe = MACHINE,
): Promise<{
  ports: ServicePorts;
  moved: { name: keyof ServicePorts; from: number; to: number }[];
}> {
  const reserved = new Set<number>([configured.web, configured.runner, configured.postgres]);
  const ports = { ...configured };
  const moved: { name: keyof ServicePorts; from: number; to: number }[] = [];
  for (const name of ['web', 'runner', 'postgres'] as const) {
    const from = configured[name];
    if (await probe.bindable(from)) continue;
    const to = await probe.freeFrom(from + 1, reserved);
    reserved.add(to);
    ports[name] = to;
    moved.push({ name, from, to });
  }
  return { ports, moved };
}

export const DEFAULT_PORTS = {
  web: 3000,
  runner: 3001,
  postgres: 25432,
} as const;

/** One configured port that had to be abandoned for a free neighbour. */
export interface PortRotation {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  /**
   * The pid still holding the old port, when a probe measured one. Null when
   * the port is unbindable for another reason — a Windows reservation, a ghost
   * socket bound to a dead pid — and there is nobody to name.
   */
  readonly heldBy: number | null;
}

/**
 * What the user reads when `up` moves to another port.
 *
 * It used to print the move and nothing else, and that hid the more important
 * half (review pass 3 of #114). After a hard Ctrl+C on a machine whose process
 * table will not answer, a recorded child can still hold :3000: every path
 * refuses it, correctly — nothing is killed on an unconfirmed identity — and
 * `up` then rotates around it. The stack comes back on :3001 and the old worker
 * is still there, holding the old port, invisible.
 *
 * Refusing remains the right behaviour. Saying nothing about it is not: the
 * user is the only one who can decide what that pid is, and they cannot decide
 * about a process nobody told them existed.
 */
export function formatPortRotation(changes: readonly PortRotation[]): string[] {
  const lines: string[] = [];
  for (const c of changes) {
    lines.push(`  - ${c.name}: ${c.from} → ${c.to}`);
    if (c.heldBy === null) continue;
    lines.push(
      `    :${c.from} is STILL HELD by pid ${c.heldBy}, which was not stopped: nothing here` +
        ` could confirm what it is.`,
      `    It is left running and the port is abandoned, not freed. Check that pid and stop` +
        ` it yourself if it is ours.`,
    );
  }
  return lines;
}
