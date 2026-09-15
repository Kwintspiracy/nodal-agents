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
 */
export function findFreePort(preferred: number, maxAttempts = 20): Promise<number> {
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

export const DEFAULT_PORTS = {
  web: 3000,
  runner: 3001,
  postgres: 25432,
} as const;
