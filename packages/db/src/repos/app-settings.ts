// repos/app-settings.ts — machine-global AND entity-scoped key/value settings.
//
// updated_at is set DB-side via `now()` (never a JS Date passed into a sql
// template) to avoid the postgres.js raw-Date serialization throw that pglite
// tolerates but production postgres.js does not.

import { and, eq, sql } from 'drizzle-orm';
import type { AnyDrizzleDb } from '../client.ts';
import { appSettings, entitySettings } from '../schema/index.ts';

/** Key for the operator-authored install notes injected into the runtime block. */
export const INSTALL_NOTES_KEY = 'install_notes';

/** Read a single app setting; returns '' when the key is unset. */
export async function getAppSetting(db: AnyDrizzleDb, key: string): Promise<string> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .limit(1);
  return row?.value ?? '';
}

/** Upsert a single app setting (insert or update the existing row). */
export async function setAppSetting(db: AnyDrizzleDb, key: string, value: string): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: sql`now()` } });
}

/**
 * Read a single entity-scoped setting; returns '' when the key is unset for
 * that entity. Two entities writing the same key never see each other's
 * value — the composite (entity_id, key) primary key is the isolation
 * boundary (M-2, audit #2).
 */
export async function getEntitySetting(
  db: AnyDrizzleDb,
  entityId: string,
  key: string,
): Promise<string> {
  const [row] = await db
    .select({ value: entitySettings.value })
    .from(entitySettings)
    .where(and(eq(entitySettings.entityId, entityId), eq(entitySettings.key, key)))
    .limit(1);
  return row?.value ?? '';
}

/** Upsert a single entity-scoped setting (insert or update the existing row). */
export async function setEntitySetting(
  db: AnyDrizzleDb,
  entityId: string,
  key: string,
  value: string,
): Promise<void> {
  await db
    .insert(entitySettings)
    .values({ entityId, key, value })
    .onConflictDoUpdate({
      target: [entitySettings.entityId, entitySettings.key],
      set: { value, updatedAt: sql`now()` },
    });
}

/** Operator-authored install notes, scoped to one entity/workspace. */
export async function getInstallNotes(db: AnyDrizzleDb, entityId: string): Promise<string> {
  return getEntitySetting(db, entityId, INSTALL_NOTES_KEY);
}

export async function setInstallNotes(
  db: AnyDrizzleDb,
  entityId: string,
  notes: string,
): Promise<void> {
  return setEntitySetting(db, entityId, INSTALL_NOTES_KEY, notes);
}
