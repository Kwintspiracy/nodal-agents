// @nodal-agents/memory — mutateMemory: the ONE function that changes a fact
// after it was saved.
//
// A fact enters memory through `createMemory` (crud.ts). Every later change
// (edit, archive, retire, restore, re-score, pin, unpin, putting a previous
// version back) comes here, whoever asks: the owner from the dashboard, an
// agent's memory tool, the weekly curator, the deterministic archiver. Three
// rules hold for all of them, in one place:
//
// 1. "The row I read". The caller states the version it read
//    (`agent_memory.version`). The UPDATE applies only if the row is still that
//    version, and bumps it. A change prepared on a row that someone changed in
//    the meantime is refused (`stale`), never applied on top.
// 2. The owner's marks are honoured in the WHERE of the UPDATE. A fact the
//    owner wrote (`source = 'manual'`) or pinned (`importance_locked`) is
//    changed by the owner only; every other actor gets `owner_protected`.
//    Pin and unpin ARE owner marks: only the owner sets or clears them.
// 3. The previous state is kept. In the same transaction, the state the fact
//    had before the change is written to `agent_memory_versions`, with who or
//    what changed it, so any change can be put back (`revert`).
//
// A change that makes a text active (an edit, a restore, a revert) passes the
// same checks as a create: the content rules of `sanitizeMemoryContent` and
// the exact-duplicate rule among the workspace's active facts. A new text
// drops the stored vector, which described the old one; the boot backfill
// embeds the new text.
//
// What this function does NOT cover, on purpose: usage counters
// (access-tracking.ts) and the derived vector (backfill.ts) are not part of
// the fact and do not bump its version; the owner's permanent delete is
// `deleteMemory`. The architecture test `memory-mutation-chokepoint.test.ts`
// fails on any other UPDATE of agent_memory in source.

import { agentMemory, agentMemoryVersions, and, eq, inArray, ne, sql } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { AgentMemory } from '@nodal-agents/shared';
import { rowToMemory } from './crud';
import type { MemoryRow } from './crud';
import { MemorySanitationError } from './errors';
import { computeFactHash } from './hash';
import { sanitizeMemoryContent } from './sanitize';

/** Who or what asks for the change. Only `owner` may change what the owner marked. */
export type MemoryActor =
  | { kind: 'owner' }
  | { kind: 'agent'; agentId: string }
  | { kind: 'curator' }
  | { kind: 'lifecycle' };

export type MemoryChange =
  /** Replace the text. */
  | { kind: 'edit'; fact: string }
  /** Archive (reversible). */
  | { kind: 'archive' }
  /** Archive as outdated: also closes the validity window. */
  | { kind: 'retire' }
  /** Make the fact active again: archived off AND validity window reopened. */
  | { kind: 'restore' }
  /** Change the importance, leaving the owner's pin as it is. */
  | { kind: 'rescore'; importance: number }
  /** Owner's pin: set the importance and lock it. */
  | { kind: 'pin'; importance: number }
  /** Owner's unpin: clear the lock, keep the value. */
  | { kind: 'unpin' }
  /** Put back the state a version row recorded (its text, category, importance, archived state). */
  | { kind: 'revert'; versionId: string };

export interface MutateMemoryInput {
  entityId: string;
  memoryId: string;
  /** The version the caller read. The change applies only to that version. */
  readVersion: number;
  actor: MemoryActor;
  change: MemoryChange;
  /** Why, when the caller has one (kept with the previous version). */
  reason?: string;
}

export type MutateMemoryRefusal =
  | 'not_found'
  | 'stale'
  | 'owner_protected'
  | 'owner_only'
  | 'duplicate'
  | 'invalid'
  | 'version_not_found';

export type MutateMemoryResult =
  | { ok: true; memory: AgentMemory }
  | {
      ok: false;
      reason: MutateMemoryRefusal;
      /** Plain explanation, safe to hand back to a model or show in an error. */
      detail: string;
      /** The version the row is at now, when it exists. */
      currentVersion?: number;
    };

type MemoryUpdateSet = Partial<typeof agentMemory.$inferInsert>;

const ACTION_OF: Record<MemoryChange['kind'], string> = {
  edit: 'edit',
  archive: 'archive',
  retire: 'retire',
  restore: 'restore',
  rescore: 'rescore',
  pin: 'pin',
  unpin: 'unpin',
  revert: 'revert',
};

function refuse(
  reason: MutateMemoryRefusal,
  detail: string,
  currentVersion?: number,
): MutateMemoryResult {
  return currentVersion === undefined
    ? { ok: false, reason, detail }
    : { ok: false, reason, detail, currentVersion };
}

function validImportance(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 5;
}

/**
 * Change one fact. See the module comment for the three rules. Returns the
 * new row, or a refusal that names why; a database error propagates.
 */
export async function mutateMemory(
  db: AnyDrizzleDb,
  input: MutateMemoryInput,
): Promise<MutateMemoryResult> {
  const { entityId, memoryId, readVersion, actor, change } = input;
  const isOwner = actor.kind === 'owner';

  return db.transaction(async (tx) => {
    // The state before the change: what the version row will keep. Locked so
    // that nothing changes it between this read and the UPDATE below.
    const [prev] = (await tx
      .select()
      .from(agentMemory)
      .where(and(eq(agentMemory.id, memoryId), eq(agentMemory.entityId, entityId)))
      .for('update')
      .limit(1)) as MemoryRow[];
    if (!prev) return refuse('not_found', `memory ${memoryId} does not exist in this workspace.`);

    if ((change.kind === 'pin' || change.kind === 'unpin') && !isOwner) {
      return refuse('owner_only', 'only the owner pins or unpins a memory.', prev.version);
    }

    // ── The state after the change ───────────────────────────────────────────
    const set: MemoryUpdateSet = {};
    switch (change.kind) {
      case 'edit': {
        const fact = change.fact.trim();
        if (fact.length === 0) {
          return refuse('invalid', 'the new text of a memory cannot be empty.', prev.version);
        }
        set.fact = fact;
        break;
      }
      case 'archive':
        set.archived = true;
        break;
      case 'retire':
        set.archived = true;
        set.validTo = new Date();
        break;
      case 'restore':
        set.archived = false;
        set.validTo = null;
        break;
      case 'rescore':
      case 'pin':
        if (!validImportance(change.importance)) {
          return refuse('invalid', 'importance must be an integer from 1 to 5.', prev.version);
        }
        set.importance = change.importance;
        if (change.kind === 'pin') set.importanceLocked = true;
        break;
      case 'unpin':
        set.importanceLocked = false;
        break;
      case 'revert': {
        const [v] = await tx
          .select()
          .from(agentMemoryVersions)
          .where(
            and(
              eq(agentMemoryVersions.id, change.versionId),
              eq(agentMemoryVersions.memoryId, memoryId),
              eq(agentMemoryVersions.entityId, entityId),
            ),
          )
          .limit(1);
        if (!v) {
          return refuse(
            'version_not_found',
            `version ${change.versionId} is not a previous version of memory ${memoryId}.`,
            prev.version,
          );
        }
        set.fact = v.fact;
        set.category = v.category;
        set.importance = v.importance;
        set.archived = v.archived;
        set.validTo = v.validTo;
        break;
      }
    }

    // ── A text that is (or stays) active passes the rules of a create ────────
    const nextFact = set.fact ?? prev.fact;
    const textChanged = set.fact !== undefined && set.fact !== prev.fact;
    if (textChanged) {
      try {
        sanitizeMemoryContent(nextFact);
      } catch (err) {
        if (err instanceof MemorySanitationError) {
          return refuse('invalid', err.detail, prev.version);
        }
        throw err;
      }
      set.factHash = computeFactHash(nextFact);
      // The stored vector described the old text.
      set.embedding = null;
    }
    const nextArchived = set.archived ?? prev.archived ?? false;
    const becomesActiveText = !nextArchived && (textChanged || (prev.archived ?? false));
    if (becomesActiveText) {
      const hash = set.factHash ?? prev.factHash ?? computeFactHash(nextFact);
      const [dup] = await tx
        .select({ id: agentMemory.id })
        .from(agentMemory)
        .where(
          and(
            eq(agentMemory.entityId, entityId),
            eq(agentMemory.factHash, hash),
            eq(agentMemory.archived, false),
            ne(agentMemory.id, memoryId),
          ),
        )
        .limit(1);
      if (dup) {
        return refuse(
          'duplicate',
          `an active memory (${dup.id}) already holds this exact text.`,
          prev.version,
        );
      }
    }

    // ── The UPDATE: the row I read, and the owner's marks, in its WHERE ──────
    const conditions = [
      eq(agentMemory.id, memoryId),
      eq(agentMemory.entityId, entityId),
      eq(agentMemory.version, readVersion),
    ];
    if (!isOwner) {
      conditions.push(sql`coalesce(${agentMemory.source}, 'agent') <> 'manual'`);
      conditions.push(eq(agentMemory.importanceLocked, false));
    }
    const updated = (await tx
      .update(agentMemory)
      .set({ ...set, version: sql`${agentMemory.version} + 1`, updatedAt: new Date() })
      .where(and(...conditions))
      .returning()) as MemoryRow[];

    const row = updated[0];
    if (!row) {
      if (prev.version !== readVersion) {
        return refuse(
          'stale',
          `memory ${memoryId} changed since it was read (read version ${readVersion}, now ${prev.version}); read it again before changing it.`,
          prev.version,
        );
      }
      if (!isOwner && (prev.source === 'manual' || prev.importanceLocked)) {
        return refuse(
          'owner_protected',
          prev.source === 'manual'
            ? `memory ${memoryId} was written by the owner; only the owner changes it.`
            : `memory ${memoryId} is pinned by the owner; only the owner changes it.`,
          prev.version,
        );
      }
      // The row is locked and every condition was checked above: nothing else
      // can refuse it. Say so rather than report a success that did not happen.
      throw new Error(`memory.mutate_no_row:${memoryId}`);
    }

    await tx.insert(agentMemoryVersions).values({
      memoryId,
      entityId,
      version: prev.version,
      fact: prev.fact,
      category: prev.category,
      importance: prev.importance,
      importanceLocked: prev.importanceLocked,
      archived: prev.archived ?? false,
      validTo: prev.validTo,
      changedBy: actor.kind,
      agentId: actor.kind === 'agent' ? actor.agentId : null,
      action: ACTION_OF[change.kind],
      reason: input.reason ?? null,
    });

    return { ok: true, memory: rowToMemory(row) };
  });
}

// ─── Reading the previous versions ─────────────────────────────────────────────

export interface MemoryVersion {
  id: string;
  memoryId: string;
  /** The version this state carried before the change. */
  version: number;
  fact: string;
  category: string | null;
  importance: number | null;
  importanceLocked: boolean;
  archived: boolean;
  validTo: string | null;
  changedBy: MemoryActor['kind'];
  agentId: string | null;
  action: string;
  reason: string | null;
  changedAt: string;
}

function toVersion(r: typeof agentMemoryVersions.$inferSelect): MemoryVersion {
  return {
    id: r.id,
    memoryId: r.memoryId,
    version: r.version,
    fact: r.fact,
    category: r.category,
    importance: r.importance,
    importanceLocked: r.importanceLocked,
    archived: r.archived,
    validTo: r.validTo?.toISOString() ?? null,
    changedBy: r.changedBy as MemoryActor['kind'],
    agentId: r.agentId,
    action: r.action,
    reason: r.reason,
    changedAt: r.createdAt.toISOString(),
  };
}

/** Every previous version of one fact, the most recent first. */
export async function listMemoryVersions(
  db: AnyDrizzleDb,
  entityId: string,
  memoryId: string,
): Promise<MemoryVersion[]> {
  const rows = await db
    .select()
    .from(agentMemoryVersions)
    .where(
      and(eq(agentMemoryVersions.memoryId, memoryId), eq(agentMemoryVersions.entityId, entityId)),
    )
    .orderBy(sql`${agentMemoryVersions.version} DESC`);
  return rows.map(toVersion);
}

/**
 * The most recent previous version of each of the given facts (the state
 * before their last change), keyed by memory id. Facts never changed have none.
 */
export async function latestMemoryVersions(
  db: AnyDrizzleDb,
  entityId: string,
  memoryIds: readonly string[],
): Promise<Map<string, MemoryVersion>> {
  const out = new Map<string, MemoryVersion>();
  if (memoryIds.length === 0) return out;
  const rows = await db
    .selectDistinctOn([agentMemoryVersions.memoryId])
    .from(agentMemoryVersions)
    .where(
      and(
        eq(agentMemoryVersions.entityId, entityId),
        inArray(agentMemoryVersions.memoryId, [...memoryIds]),
      ),
    )
    .orderBy(agentMemoryVersions.memoryId, sql`${agentMemoryVersions.version} DESC`);
  for (const r of rows) out.set(r.memoryId, toVersion(r));
  return out;
}
