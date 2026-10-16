// bootstrap/seed-llm-key.ts — Brique 24 / Brique 25
//
// On runner startup, if the single local workspace has zero entity_llm_keys rows
// AND LLM_PROVIDER + LLM_MODEL are configured in env, seed a default row from
// env so existing agents (which were created against the env-based singleton)
// continue to work without manual setup.
//
// Atomic (Finding F-22): the key insert and the initial agent-wiring UPDATE
// used to be two separate statements — a throw between them on a prior boot
// stranded agents permanently (the next boot saw keyCount > 0 and skipped
// wiring entirely). Both statements now run inside a single `db.transaction`,
// so that intermediate state is impossible: either both commit or neither
// does, and the next boot's `keyCount > 0` check is a reliable "already fully
// seeded" signal again.
//
// IMPORTANT — this function only ever wires an agent ONCE, the first time the
// entity's default key is created. It deliberately does NOT re-wire agents
// with llmKeyId=NULL on later boots: an agent can end up NULL either because
// it was never seeded, or because the user deliberately deleted/rotated the
// key it pointed at (ON DELETE SET NULL preserves the agent on key deletion —
// see deleteLlmKeyAction). Those two cases are indistinguishable from here,
// and re-wiring on every boot would silently override the user's deliberate
// detachment onto a provider they never chose for that agent — a silent
// smart fallback (invariant #4). So: seed once, atomically, and never touch
// agents.llmKeyId again after that.
//
// Guard logic (Brique 25):
//   - bearer-token mode: skip (multi-tenant, admins manage keys via UI)
//   - exactly 1 workspace someone is a member of → seed for that one (works
//     for both local-trust and single-user local-auth installs like Quentin's)
//   - 0 or >1 such workspaces → skip (first boot before sign-up; several
//     workspaces, where the env key belongs to no one in particular), and
//     SAY it once when entities exist but none has a member, or when a
//     workspace among several has no key
//
// "A workspace someone is a member of" (`listMemberWorkspaces`), not "an
// entity": the env key is the install owner's, and an entity no person is a
// member of — a team copy driven by a tool, which never shows in the
// dashboard — is nobody's. Counting every entity made such a copy switch the
// seed off for the owner's own workspace.

import {
  count,
  eq,
  isNull,
  and,
  entityLlmKeys,
  agents,
  entities,
  listMemberWorkspaces,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { encrypt, last4 } from '@nodal-agents/secrets';
import type { RunnerEnv } from '../env.ts';

// The seed is retried on every cron tick: a skip is said once per process,
// not every two minutes.
const warned = new Set<string>();
function warnOnce(line: string): void {
  if (warned.has(line)) return;
  warned.add(line);
  console.warn(line);
}

/** Tests only: forget which skips were already said. */
export function _resetSeedLlmKeyWarningsForTests(): void {
  warned.clear();
}

export async function seedDefaultLlmKey(db: AnyDrizzleDb, env: RunnerEnv): Promise<void> {
  // bearer-token mode = multi-tenant; admins manage keys via UI, never auto-seed.
  if (env.AUTH_MODE === 'bearer-token') return;
  if (!env.LLM_PROVIDER || !env.LLM_MODEL) return;
  // Narrowing `env.LLM_PROVIDER` above doesn't persist into the transaction
  // closure below (TS widens captured properties back to their declared
  // type inside callbacks) — hoist it to a local const so the insert below
  // still sees `string`, not `string | undefined`.
  const llmProvider = env.LLM_PROVIDER;

  // Resolve target workspace: exactly 1 that someone is a member of.
  // - local-trust: LOCAL_ENTITY_ID, its member seeded by seedLocalUser
  // - local-auth single-user: the workspace the sign-up hook created → seeds
  // - several workspaces (dashboard-created, or multi-user): skip, no guess
  const workspaces = await listMemberWorkspaces(db);
  if (workspaces.length === 0) {
    // First boot before sign-up: no entity at all, nothing to say. Entities
    // WITHOUT a member are another story: before this rule, a lone entity was
    // enough, and it would now lose its seed in silence (invariant #4).
    const [entityCountRow] = await db.select({ n: count() }).from(entities);
    const n = entityCountRow?.n ?? 0;
    if (n > 0) {
      warnOnce(
        `[runner] seed_llm_key_skipped: ${n} workspace(s) exist but none has a member ` +
          '(entity_members), so the env LLM key belongs to no one and is not seeded. ' +
          "In local-trust, seedLocalUser restores the local workspace's member at every boot, " +
          'before this seed. Otherwise add the owner as a member of the workspace, or add the ' +
          'key in Settings > LLM keys.',
      );
    }
    return;
  }
  if (workspaces.length > 1) {
    // Several workspaces: the env key is nobody's in particular. Said only when
    // one of them has no key, the only case where the seed would have mattered.
    const keyless: string[] = [];
    for (const w of workspaces) {
      const [k] = await db
        .select({ n: count() })
        .from(entityLlmKeys)
        .where(eq(entityLlmKeys.entityId, w.id));
      if ((k?.n ?? 0) === 0) keyless.push(w.name);
    }
    if (keyless.length > 0) {
      warnOnce(
        `[runner] seed_llm_key_skipped: ${workspaces.length} workspaces have a member, so the ` +
          `env LLM key belongs to none in particular; ${keyless.join(', ')} has no key. ` +
          'Add it in Settings > LLM keys of that workspace.',
      );
    }
    return;
  }

  const targetEntityId = workspaces[0]!.id;

  const [keyCountRow] = await db
    .select({ n: count() })
    .from(entityLlmKeys)
    .where(eq(entityLlmKeys.entityId, targetEntityId));

  // Already seeded (or the user manages keys manually from here) — never
  // re-wire agents.llmKeyId again, see the file-level comment above.
  if ((keyCountRow?.n ?? 0) > 0) return;

  const plaintextKey = env.LLM_API_KEY ?? '';

  await db.transaction(async (tx) => {
    const [newKey] = await tx
      .insert(entityLlmKeys)
      .values({
        entityId: targetEntityId,
        provider: llmProvider,
        apiKey: encrypt(plaintextKey),
        apiKeyLast4: last4(plaintextKey),
        baseUrl: env.LLM_BASE_URL ?? null,
        nickname: 'Default (env)',
        isActive: true,
      })
      .returning({ id: entityLlmKeys.id });

    if (!newKey) {
      throw new Error('seedDefaultLlmKey: key insert returned no row — rolling back');
    }

    const wired = await tx
      .update(agents)
      .set({ llmKeyId: newKey.id, updatedAt: new Date() })
      .where(and(eq(agents.entityId, targetEntityId), isNull(agents.llmKeyId)))
      .returning({ id: agents.id });

    console.warn(
      `[runner] seeded default LLM key ${newKey.id} from env (entityId=${targetEntityId}), ` +
        `wired ${wired.length} agent(s)`,
    );
  });
}
