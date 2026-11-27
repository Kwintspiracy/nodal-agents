// passphrase.ts — where a backup's passphrase comes from.
//
// ONE source per call, in this order: the environment variable (for a script
// or a scheduled task, the way restic and borg take theirs), else the person
// types it at the terminal, hidden, twice when it is new. No terminal and no
// variable: refused, never an archive left unprotected in silence.

import prompts from 'prompts';

/** The variable a script sets to pass the passphrase without a terminal. */
export const BACKUP_PASSPHRASE_ENV = 'NODALAI_BACKUP_PASSPHRASE';

export interface PassphraseSource {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly interactive: boolean;
  /** Ask once, hidden; undefined when the person cancelled. */
  readonly ask: (message: string) => Promise<string | undefined>;
}

const terminal: PassphraseSource = {
  env: process.env,
  interactive: process.stdin.isTTY === true,
  ask: async (message) => {
    const answer = (await prompts({ type: 'password', name: 'value', message })) as {
      value?: string;
    };
    return answer.value;
  },
};

/**
 * The passphrase. `confirm`: a new one, typed twice. Throws when none can be
 * had, or the two differ, or it is empty.
 */
export async function readPassphrase(
  opts: { readonly confirm: boolean; readonly purpose: string },
  source: PassphraseSource = terminal,
): Promise<string> {
  const fromEnv = source.env[BACKUP_PASSPHRASE_ENV];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  if (!source.interactive) {
    throw new Error(
      `${opts.purpose} needs a passphrase, and there is no terminal to type it in. ` +
        `Set ${BACKUP_PASSPHRASE_ENV}, or run the command in a terminal.`,
    );
  }
  const first = await source.ask(
    opts.confirm ? 'Passphrase for the backup' : 'Passphrase of the backup',
  );
  if (first === undefined || first === '') {
    throw new Error(`${opts.purpose} needs a passphrase, and none was typed. Nothing was done.`);
  }
  if (opts.confirm) {
    const again = await source.ask('The same passphrase again');
    if (again !== first) {
      throw new Error('The two passphrases differ. Nothing was written.');
    }
  }
  return first;
}
