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
import { isEncrypted, masterKeyFileMissing } from '@nodal-agents/secrets';
import type { AnyDrizzleDb } from '../client.ts';

export interface AssertMasterKeyRestorableOptions {
  /** Override the master key path — test-only. Defaults to ~/.nodalai/secrets.key. */
  keyPath?: string;
}

/**
 * Throws if the master key file is missing AND the database already has
 * encrypted data that depends on it. No-op (including on a fresh install
 * with zero rows) when the key file is present, or when it's absent but the
 * DB has nothing encrypted yet.
 */
export async function assertMasterKeyRestorable(
  db: AnyDrizzleDb,
  options: AssertMasterKeyRestorableOptions = {},
): Promise<void> {
  if (!masterKeyFileMissing(options.keyPath)) return;

  // credentials.payload is ALWAYS an encrypted blob once a row exists (see
  // schema/credentials.ts) — any row at all means the missing key would
  // orphan it.
  const [credRow] = await db.select({ id: credentials.id }).from(credentials).limit(1);
  if (credRow) throw missingKeyError('a stored OAuth credential');

  // entity_llm_keys.apiKey is '' until a key is set, then either plaintext
  // (pre-Brique-26 legacy rows, never touched by secrets.key) or encrypted.
  // Only the encrypted ones actually depend on the missing key.
  const llmKeyRows = await db.select({ apiKey: entityLlmKeys.apiKey }).from(entityLlmKeys);
  const hasEncryptedLlmKey = llmKeyRows.some((r) => r.apiKey !== '' && isEncrypted(r.apiKey));
  if (hasEncryptedLlmKey) throw missingKeyError('a stored LLM API key');

  // SEC-4 (audit sécu 2026-07-07): the guard also has to cover the OTHER
  // AES-GCM-encrypted surfaces, or an install whose ONLY secrets are a
  // connector or MCP server (no OAuth credential / LLM key) would still get a
  // silent re-mint. connectors.api_key and mcp_servers.api_key are
  // enc:-prefixed blobs; mcp_servers.env_vars is a JSON map whose VALUES are
  // individually encrypted (create-mcp.ts).
  const connectorRows = await db.select({ apiKey: connectors.apiKey }).from(connectors);
  const hasEncryptedConnector = connectorRows.some((r) => !!r.apiKey && isEncrypted(r.apiKey));
  if (hasEncryptedConnector) throw missingKeyError('a stored connector API key');

  const mcpRows = await db
    .select({ apiKey: mcpServers.apiKey, envVars: mcpServers.envVars })
    .from(mcpServers);
  const hasEncryptedMcp = mcpRows.some((r) => {
    if (r.apiKey && isEncrypted(r.apiKey)) return true;
    const env = (r.envVars ?? {}) as Record<string, unknown>;
    return Object.values(env).some((v) => typeof v === 'string' && isEncrypted(v));
  });
  if (hasEncryptedMcp) throw missingKeyError('a stored MCP server secret');
}

function missingKeyError(what: string): Error {
  return new Error(
    `~/.nodalai/secrets.key is missing, but the database already has ${what} encrypted with it. ` +
      'Generating a NEW key here would make every existing credential / LLM key permanently ' +
      'undecryptable, with no further warning. Restore the original secrets.key from a backup ' +
      'before running `nodal-agents up` again. If you intend to start fresh, delete the ' +
      'affected rows (or wipe the database) first, then retry.',
  );
}
