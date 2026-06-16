// repos/app-settings.ts — machine-global key/value settings.
//
// updated_at is set DB-side via `now()` (never a JS Date passed into a sql
// template) to avoid the postgres.js raw-Date serialization throw that pglite
// tolerates but production postgres.js does not.

import { eq, sql } from 'drizzle-orm';
import type { AnyDrizzleDb } from '../client.ts';
import { appSettings } from '../schema/index.ts';

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

/** Operator-authored install notes (machine-global). */
export async function getInstallNotes(db: AnyDrizzleDb): Promise<string> {
  return getAppSetting(db, INSTALL_NOTES_KEY);
}

export async function setInstallNotes(db: AnyDrizzleDb, notes: string): Promise<void> {
  return setAppSetting(db, INSTALL_NOTES_KEY, notes);
}
