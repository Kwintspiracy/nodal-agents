// bootstrap/migrate-plaintext-secrets.ts — encryption-at-rest for the last
// plaintext credential columns.
//
// One-shot, idempotent migration that converts every remaining PLAINTEXT
// credential column in the schema to the `enc:v1:` format:
//   - channel_bindings.credentials  (Discord / Slack / WhatsApp / Telegram mirror)
//   - agents.telegram_bot_token     (the transitional Telegram column)
//   - webhook_triggers.secret       (the inbound-webhook bearer credential)
//
// Not covered, on purpose: better-auth owns `account.access_token` /
// `refresh_token` / `id_token` and `session.token`. Those are written and read
// by the library itself, so encrypting them behind its back would break sign-in;
// they are empty in the default local-auth mode. `users.password_hash` is a
// hash, not a recoverable secret, and is correct as-is.
//
// Same shape and the same reasons as migrate-llm-keys.ts (Brique 26): runs on
// every runner boot, already-encrypted rows are skipped, so re-running is a
// no-op and there is no flag day — a DB that has not booted through this yet
// still reads fine because getBindingCredentials accepts both shapes.
//
// Why a boot migration and not a SQL migration: the master key lives on the
// filesystem (~/.nodalai/secrets.key), which SQL cannot reach. Same constraint
// that put the LLM-key migration here.

import { eq, isNotNull, agents, channelBindings, webhookTriggers } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { encrypt, isEncrypted, loadOrCreateMasterKey } from '@nodal-agents/secrets';

export async function migratePlaintextSecretsToEncrypted(db: AnyDrizzleDb): Promise<void> {
  // Eagerly load (or create) the master key so any failure surfaces here,
  // before we touch the DB — mirrors migrate-llm-keys.ts.
  loadOrCreateMasterKey();

  let bindings = 0;
  const bindingRows = await db
    .select({ id: channelBindings.id, credentials: channelBindings.credentials })
    .from(channelBindings);

  for (const row of bindingRows) {
    if (row.credentials === '' || isEncrypted(row.credentials)) continue;
    await db
      .update(channelBindings)
      .set({ credentials: encrypt(row.credentials), updatedAt: new Date() })
      .where(eq(channelBindings.id, row.id));
    bindings++;
  }

  let tokens = 0;
  const agentRows = await db
    .select({ id: agents.id, botToken: agents.telegramBotToken })
    .from(agents)
    .where(isNotNull(agents.telegramBotToken));

  for (const row of agentRows) {
    const raw = row.botToken;
    if (!raw || isEncrypted(raw)) continue;
    await db
      .update(agents)
      .set({ telegramBotToken: encrypt(raw), updatedAt: new Date() })
      .where(eq(agents.id, row.id));
    tokens++;
  }

  let secrets = 0;
  const webhookRows = await db
    .select({ id: webhookTriggers.id, secret: webhookTriggers.secret })
    .from(webhookTriggers)
    .where(isNotNull(webhookTriggers.secret));

  for (const row of webhookRows) {
    const raw = row.secret;
    if (!raw || isEncrypted(raw)) continue;
    await db
      .update(webhookTriggers)
      .set({ secret: encrypt(raw), updatedAt: new Date() })
      .where(eq(webhookTriggers.id, row.id));
    secrets++;
  }

  if (bindings > 0 || tokens > 0 || secrets > 0) {
    console.warn(
      `[secrets] migrated ${bindings} channel binding(s), ${tokens} telegram bot token(s) ` +
        `and ${secrets} webhook secret(s) to encrypted-at-rest format`,
    );
  }
}
