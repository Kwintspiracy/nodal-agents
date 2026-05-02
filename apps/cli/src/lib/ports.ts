// ports.ts — find available ports for services

import { createServer } from 'net';

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
