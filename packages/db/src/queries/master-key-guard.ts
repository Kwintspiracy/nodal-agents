// queries/master-key-guard.ts — I-6: refuse to silently mint a new master key
// when encrypted data already depends on the missing one.
//
// loadOrCreateMasterKey() (@nodal-agents/secrets) is pure — no DB access — so
// it can't tell "first boot, safe to generate" apart from "secrets.key was
// lost or restored from an incomplete backup, but the DB still has
// credentials / LLM keys encrypted with the ORIGINAL key". Silently
// generating a fresh key in the second case doesn't fail — it just makes
// every existing encrypted row permanently undecryptable (authTag mismatch on
// first use), with no signal pointing back at "you lost secrets.key" until
// something breaks downstream.
//
// Called once at CLI boot (`up`), before the runner/web processes are
// spawned — the earliest point where both the config dir (secrets.key) and
// the database are available together.

import { credentials } from '../schema/credentials.ts';
import { entityLlmKeys } from '../schema/llm_keys.ts';
import { connectors } from '../schema/connectors.ts';
import { mcpServers } from '../schema/mcp.ts';
import { channelBindings } from '../schema/channel-bindings.ts';
import { agents } from '../schema/agents.ts';
import { webhookTriggers } from '../schema/webhooks.ts';
import { getAppSetting, setAppSetting } from '../repos/app-settings.ts';
import {
  createMasterKeyFile,
  decryptsWith,
  isEncrypted,
  masterKeyCheckValue,
  masterKeyMatchesCheck,
  masterKeyPath,
  readMasterKeyFile,
} from '@nodal-agents/secrets';
import type { AnyDrizzleDb } from '../client.ts';

export interface AssertMasterKeyRestorableOptions {
  /** Override the master key path — test-only. Defaults to the home's secrets.key. */
  keyPath?: string;
}

/** The `app_settings` key holding the master key's check value (FA-07). */
export const MASTER_KEY_CHECK_SETTING = 'master_key_check';

/** One stored secret, and what it is, for the message that names it. */
interface EncryptedValue {
  readonly what: string;
  readonly blob: string;
}

/**
 * Every value in the database that is encrypted with the master key. The
 * guard below needs to know whether ANY exists (a missing key would orphan
 * it) and, on an install that has no check value yet, whether the key file
 * opens them.
 */
async function encryptedValues(db: AnyDrizzleDb): Promise<EncryptedValue[]> {
  const out: EncryptedValue[] = [];
  const push = (what: string, blob: string | null | undefined): void => {
    if (blob && isEncrypted(blob)) out.push({ what, blob });
  };

  // credentials.payload is ALWAYS an encrypted blob once a row exists (see
  // schema/credentials.ts) — any row at all means a missing key would orphan it.
  for (const r of await db.select({ payload: credentials.payload }).from(credentials)) {
    push('a stored OAuth credential', r.payload);
  }

  // entity_llm_keys.apiKey is '' until a key is set, then either plaintext
  // (pre-Brique-26 legacy rows, never touched by secrets.key) or encrypted.
  // Only the encrypted ones depend on the key.
  for (const r of await db.select({ apiKey: entityLlmKeys.apiKey }).from(entityLlmKeys)) {
    push('a stored LLM API key', r.apiKey);
  }

  // SEC-4 (audit sécu 2026-07-07): the OTHER AES-GCM-encrypted surfaces, or an
  // install whose ONLY secrets are a connector or MCP server (no OAuth
  // credential / LLM key) would still get a silent re-mint. connectors.api_key
  // and mcp_servers.api_key are enc:-prefixed blobs; mcp_servers.env_vars is a
  // JSON map whose VALUES are individually encrypted (create-mcp.ts).
  for (const r of await db.select({ apiKey: connectors.apiKey }).from(connectors)) {
    push('a stored connector API key', r.apiKey);
  }
  const mcpRows = await db
    .select({ apiKey: mcpServers.apiKey, envVars: mcpServers.envVars })
    .from(mcpServers);
  for (const r of mcpRows) {
    push('a stored MCP server secret', r.apiKey);
    for (const v of Object.values((r.envVars ?? {}) as Record<string, unknown>)) {
      if (typeof v === 'string') push('a stored MCP server secret', v);
    }
  }

  // Channel credentials + the transitional Telegram column, encrypted at rest
  // since 2026-08-28. A Telegram-only setup has no OAuth credential and may run
  // on an env-provided LLM key: without these it would sail past the guard and
  // get a silent re-mint, killing every bot at once. Legacy PLAINTEXT rows are
  // skipped: they do not depend on the key.
  const bindingRows = await db
    .select({ credentials: channelBindings.credentials })
    .from(channelBindings);
  for (const r of bindingRows) push('a stored channel credential', r.credentials);
  for (const r of await db.select({ botToken: agents.telegramBotToken }).from(agents)) {
    push('a stored channel credential (bot token)', r.botToken);
  }

  // webhook_triggers.secret is the inbound bearer credential; losing the key
  // makes every configured webhook un-authenticatable (a permanent 404).
  for (const r of await db.select({ secret: webhookTriggers.secret }).from(webhookTriggers)) {
    push('a stored webhook secret', r.secret);
  }
  return out;
}

/**
 * The master key file and the database must belong together. Called once at
 * CLI boot (`up`), before the runner and the dashboard are spawned and before
 * anything reads a secret. Throws, with a message that names the file, when:
 *
 *   - the key file is MISSING while the database holds secrets encrypted with
 *     a key (minting a new one would make them all unreadable, I-6);
 *   - the key file EXISTS but is unusable (`StateFileError` from its reader);
 *   - the key file is NOT THE KEY this database's secrets were encrypted with:
 *     the database's check value does not open with it, or, on an install
 *     that has no check value yet, none of its secrets does (FA-07).
 *
 * Otherwise it makes sure the key file exists (a new install gets its key
 * here, before the runner and the dashboard could race to mint one) and that
 * the database holds the check value of that key.
 *
 * A database holding NO encrypted value has nothing a key could lose: the
 * check value is then (re)written for the key on disk, whatever it was.
 */
export async function assertMasterKeyRestorable(
  db: AnyDrizzleDb,
  options: AssertMasterKeyRestorableOptions = {},
): Promise<void> {
  const keyPath = options.keyPath ?? masterKeyPath();
  const onDisk = readMasterKeyFile(keyPath);
  const stored = await getAppSetting(db, MASTER_KEY_CHECK_SETTING);
  if (onDisk !== null && stored !== '' && masterKeyMatchesCheck(stored, onDisk)) return;

  const values = await encryptedValues(db);
  let key: Buffer;
  if (onDisk === null) {
    const first = values[0];
    if (first) throw missingKeyError(keyPath, first.what);
    key = createMasterKeyFile(keyPath);
  } else {
    key = onDisk;
    // An install from before the check value existed has none: the key is
    // recognised when it opens a secret the database already holds.
    const recognised = stored === '' && values.some((v) => decryptsWith(v.blob, onDisk));
    if (values.length > 0 && !recognised) throw wrongKeyError(keyPath, stored !== '');
  }
  await setAppSetting(db, MASTER_KEY_CHECK_SETTING, masterKeyCheckValue(key));
}

function missingKeyError(keyPath: string, what: string): Error {
  return new Error(
    `${keyPath} is missing, but the database already has ${what} encrypted with it. ` +
      'Generating a NEW key here would make every existing credential / LLM key permanently ' +
      'undecryptable, with no further warning. Restore the original secrets.key from a backup ' +
      'before running `nodal-agents up` again. If you intend to start fresh, delete the ' +
      'affected rows (or wipe the database) first, then retry.',
  );
}

function wrongKeyError(keyPath: string, hadCheck: boolean): Error {
  const evidence = hadCheck
    ? "the database's key check does not open with it"
    : 'none of the secrets stored in the database opens with it';
  return new Error(
    `The master key file ${keyPath} is not the key this database was encrypted with: ` +
      `${evidence}.\n` +
      'Nothing was changed and Nodal did not start: with this key, every stored credential, ' +
      'LLM key and bot token would be unreadable.\n' +
      'Put back the secrets.key that belongs to this database (from the machine or the backup ' +
      'the database came from), then run `nodal-agents up` again.',
  );
}
