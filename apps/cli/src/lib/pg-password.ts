// pg-password.ts — which password the embedded database is started with, and
// how a password change survives being cut in half.
//
// SECRET-003 gave every install its own database password, kept in
// `config.json` (`postgresPassword`). A cluster created before that still
// carries the shipped one, so the first start after the upgrade moves it: a
// new value, then `ALTER USER` on the running cluster. Those are two steps,
// and a stop between them (a crash, a power cut, Ctrl+C) used to lose the
// install: the file named a password the role did not have, the next start
// read it as the confirmed one and never tried anything else (B38-21, B39-06).
//
// THE GENERAL FORM. A password the database has not accepted yet is never
// written AS the password. It is written beside it, as
// `postgresPasswordPending`, BEFORE the change, and it replaces
// `postgresPassword` only once the database has taken it. A start that finds
// a pending value finishes the change, whichever side of the `ALTER` the
// previous one stopped on:
//
//   - the database still accepts the confirmed password: the `ALTER` never
//     committed, so it is run again;
//   - it refuses the confirmed one but accepts the pending one: the `ALTER`
//     committed and only the last write was lost, so the pending value is
//     confirmed.
//
// Nothing here ever invents a password for a database that exists: when the
// database accepts neither value, the start stops and says what happened
// (`passwordMismatchMessage`).
//
// A NEW install never goes through a change at all: its password is minted
// with its config (`newInstallConfig`, config.ts), before the cluster exists,
// and `initdb` is given it directly.

import type { Config } from './config.ts';
import { LEGACY_PG_PASSWORD, PostgresAuthError } from './postgres.ts';

/** What `startWithPassword` needs from a started cluster. */
export interface PasswordChangeable {
  rotatePassword: (newPassword: string) => Promise<boolean>;
}

export interface PasswordStartDeps<P extends PasswordChangeable> {
  /** Start the cluster with this password; throws `PostgresAuthError` when refused. */
  readonly start: (password: string) => Promise<P>;
  /** Persist the config (atomically: `writeConfig`). */
  readonly save: (config: Config) => void;
  /** A new random password. */
  readonly mint: () => string;
  /** Say, loudly, that a change could not be finished now. */
  readonly warn: (message: string) => void;
}

export interface PasswordStart<P> {
  readonly pg: P;
  /** The password the database accepted at start. */
  readonly password: string;
  /** The password being moved to, when a change is under way. */
  readonly pending: string | null;
  /** True when the database accepted `pending` already (the change committed). */
  readonly acceptedPending: boolean;
  /** The config as it is on disk now. */
  readonly config: Config;
}

/**
 * Start the cluster with the password it has. When a change is under way
 * (a recorded `postgresPasswordPending`, or a cluster still on the shipped
 * password, for which one is recorded FIRST), the confirmed password is tried
 * and, refused, the pending one. `finishPasswordChange` completes the move.
 */
export async function startWithPassword<P extends PasswordChangeable>(
  initial: Config,
  deps: Pick<PasswordStartDeps<P>, 'start' | 'save' | 'mint'>,
): Promise<PasswordStart<P>> {
  let config = initial;
  const confirmed = config.postgresPassword ?? LEGACY_PG_PASSWORD;
  let pending = config.postgresPasswordPending ?? null;
  if (config.postgresPassword === undefined && pending === null) {
    // A cluster from before per-install passwords: start the change, the new
    // value on disk FIRST.
    pending = deps.mint();
    config = { ...config, postgresPasswordPending: pending };
    deps.save(config);
  }
  try {
    const pg = await deps.start(confirmed);
    return { pg, password: confirmed, pending, acceptedPending: false, config };
  } catch (err) {
    if (!(err instanceof PostgresAuthError) || pending === null) throw err;
    // The confirmed password is refused while a change is recorded: the
    // previous start stopped after the ALTER and before confirming it.
    const pg = await deps.start(pending);
    return { pg, password: pending, pending, acceptedPending: true, config };
  }
}

/**
 * Finish the change `startWithPassword` found under way: run the `ALTER` if
 * the database has not taken the pending password yet, then confirm it in the
 * config. Returns the password the database accepts and the config on disk.
 * When the `ALTER` fails, the pending value stays recorded and the next start
 * runs the change again; that is said, loudly.
 */
export async function finishPasswordChange<P extends PasswordChangeable>(
  started: PasswordStart<P>,
  deps: Pick<PasswordStartDeps<P>, 'save' | 'warn'>,
): Promise<{ password: string; config: Config }> {
  const { pending, config } = started;
  if (pending === null) return { password: started.password, config };
  const moved = started.acceptedPending || (await started.pg.rotatePassword(pending));
  if (!moved) {
    deps.warn(
      'Could not change the local database password: the database still uses the previous one.\n' +
        (config.postgresPassword === undefined
          ? 'That is the shipped default: any other process on this machine can read the database.\n'
          : '') +
        'The change is retried on the next start.',
    );
    return { password: started.password, config };
  }
  const confirmed: Config = {
    ...config,
    postgresPassword: pending,
    postgresPasswordPending: undefined,
  };
  deps.save(confirmed);
  return { password: pending, config: confirmed };
}

/**
 * What a person reads when the database accepts none of the passwords the
 * config holds. Nothing is changed and nothing is generated: the database's
 * password is the one it was created with, and only a copy of it can open it.
 */
export function passwordMismatchMessage(configFile: string, lastGoodCopy: string | null): string {
  const lines = [
    `The local database refused the password held in ${configFile}. ` +
      'The database was stopped again, and nothing was changed.',
    `This happens when ${configFile} was replaced after the database was created: by ` +
      '`nodal-agents init` in an older version, by a save cut short, or by an edit. Nodal ' +
      'never creates a new password over an existing database: the right one is in a copy of ' +
      'that file.',
  ];
  lines.push(
    lastGoodCopy !== null
      ? `The version of the file before its last change is kept at ${lastGoodCopy}: if its ` +
          `"postgresPassword" differs, put that value back in ${configFile}, then run ` +
          '`nodal-agents up` again.'
      : `If you have a backup of ${configFile}, put its "postgresPassword" value back in the ` +
          'file, then run `nodal-agents up` again.',
  );
  return lines.join('\n');
}
