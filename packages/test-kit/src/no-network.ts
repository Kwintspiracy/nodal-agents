// no-network.ts — a test that reaches the network fails.
//
// Every TCP connection a Node process opens goes through
// `net.Socket.prototype.connect`: `http`/`https` (node-fetch, axios, the
// SDKs that use them), `undici` (the global `fetch`), `tls`. The guard wraps
// that one method: a connection to anything but this machine (a loopback
// address, a local pipe) is refused before any DNS lookup or packet, the
// socket fails with `NetworkForbiddenError`, and the attempt is recorded.
//
// The setup file (`setup-no-network.ts`) installs it for a whole test file and
// fails the file if any attempt was recorded, whichever test made it and
// whether or not the test caught the error. A suite that expects some code to
// try the network (the connector conformance suite, proving which adapters do
// not go through the contract's transport) runs that code inside
// `withNetworkScope`: the attempts made there are returned to it and only it.

import { AsyncLocalStorage } from 'node:async_hooks';
import net from 'node:net';

export class NetworkForbiddenError extends Error {
  readonly code = 'ENETFORBIDDEN';
  constructor(readonly target: string) {
    super(`network forbidden in tests: a connection to ${target} was refused before it left`);
    this.name = 'NetworkForbiddenError';
  }
}

export interface NetworkAttempt {
  readonly target: string;
  /** The `withNetworkScope` label it was made under, or null. */
  readonly scope: string | null;
  readonly stack: string;
  /** `hold` scopes: when the client gave the connection up (null while it waits). */
  closedAt: number | null;
}

/**
 * What the guard does with a connection made inside a scope: `refuse` fails
 * it at once (the default, and always outside a scope); `hold` never
 * completes it, a provider that never answers, until the client gives it up.
 */
export type NetworkScopeMode = 'refuse' | 'hold';

interface Scope {
  label: string;
  mode: NetworkScopeMode;
  attempts: NetworkAttempt[];
  held: net.Socket[];
}

const scopes = new AsyncLocalStorage<Scope>();
const unscoped: NetworkAttempt[] = [];
let original: typeof net.Socket.prototype.connect | null = null;

function isLocal(host: string | undefined): boolean {
  if (host === undefined || host === '') return true; // Node's default host is localhost
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h.startsWith('127.') || h === '0.0.0.0';
}

/** Where a `connect` call goes, from any of its signatures. */
function targetOf(args: unknown[]): { local: boolean; target: string } {
  let first: unknown = args[0];
  // net.connect() hands the normalized [options, callback] pair.
  if (Array.isArray(first)) first = first[0];
  if (typeof first === 'string') return { local: true, target: first }; // a pipe / unix socket
  if (typeof first === 'number') {
    const host = typeof args[1] === 'string' ? args[1] : undefined;
    return { local: isLocal(host), target: `${host ?? 'localhost'}:${first}` };
  }
  if (typeof first === 'object' && first !== null) {
    const o = first as { path?: unknown; host?: unknown; port?: unknown };
    if (typeof o.path === 'string') return { local: true, target: o.path };
    const host = typeof o.host === 'string' ? o.host : undefined;
    return { local: isLocal(host), target: `${host ?? 'localhost'}:${String(o.port ?? '')}` };
  }
  return { local: false, target: String(first) };
}

/** Install the guard (idempotent). */
export function installNetworkGuard(): void {
  if (original) return;
  const connect = net.Socket.prototype.connect;
  original = connect;
  net.Socket.prototype.connect = function guardedConnect(
    this: net.Socket,
    ...args: unknown[]
  ): net.Socket {
    const { local, target } = targetOf(args);
    if (local) return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
    const scope = scopes.getStore();
    const attempt: NetworkAttempt = {
      target,
      scope: scope?.label ?? null,
      stack: new Error().stack ?? '',
      closedAt: null,
    };
    (scope ? scope.attempts : unscoped).push(attempt);
    if (scope?.mode === 'hold') {
      // Never connected, so nothing leaves; the client's abort or time-out
      // destroys it, which is when it gave the request up.
      this.once('close', () => {
        attempt.closedAt = Date.now();
      });
      scope.held.push(this);
      return this;
    }
    process.nextTick(() => this.destroy(new NetworkForbiddenError(target)));
    return this;
  } as typeof net.Socket.prototype.connect;
}

/** Remove the guard. */
export function uninstallNetworkGuard(): void {
  if (!original) return;
  net.Socket.prototype.connect = original;
  original = null;
}

/** The attempts made outside any scope since the guard was installed (and clears them). */
export function takeUnscopedNetworkAttempts(): NetworkAttempt[] {
  return unscoped.splice(0, unscoped.length);
}

/**
 * Run `fn` and return, beside its outcome, the network attempts made inside
 * it. Those attempts are this caller's to judge: they are not counted against
 * the test file.
 */
export async function withNetworkScope<T>(
  label: string,
  fn: (live: readonly NetworkAttempt[]) => Promise<T>,
  mode: NetworkScopeMode = 'refuse',
): Promise<{ outcome: PromiseSettledResult<T>; attempts: NetworkAttempt[] }> {
  const store: Scope = { label, mode, attempts: [], held: [] };
  const outcome = await scopes.run(store, async () => {
    try {
      return { status: 'fulfilled', value: await fn(store.attempts) } as const;
    } catch (reason) {
      return { status: 'rejected', reason } as const;
    }
  });
  // Snapshot before the held connections still open are released.
  const attempts = store.attempts.map((a) => ({ ...a }));
  for (const socket of store.held) socket.destroy();
  return { outcome, attempts };
}

/** The message a test file fails with when something in it tried the network. */
export function networkAttemptsMessage(attempts: readonly NetworkAttempt[]): string {
  const lines = attempts.map(
    (a) => `  - ${a.target}\n${a.stack.split('\n').slice(2, 8).join('\n')}`,
  );
  return (
    `${attempts.length} connection(s) to the network were attempted by this test file ` +
    `(refused before leaving). A test fakes its provider; it never reaches it:\n${lines.join('\n')}`
  );
}
