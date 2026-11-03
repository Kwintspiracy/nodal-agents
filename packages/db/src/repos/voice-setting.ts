// repos/voice-setting.ts — la voix d'un espace, lue et écrite (#969).
//
// La ligne `entity_settings` de clé `voice`, posée pour tout espace par la
// migration 0158 (et à la naissance de chaque espace, par son déclencheur).
// La lecture distingue ce que `getEntitySetting` confond : une ligne ABSENTE
// n'est pas une ligne vide, et ni l'une ni l'autre ne devient une voix par
// défaut (invariant #4).

import { and, eq, sql } from 'drizzle-orm';
import {
  parseVoiceSetting,
  VOICE_SETTING_KEY,
  VoiceSettingSchema,
  type VoiceSetting,
} from '@nodal-agents/shared';
import type { AnyDrizzleDb } from '../client.ts';
import { entitySettings } from '../schema/index.ts';

export type VoiceSettingRead =
  | { ok: true; setting: VoiceSetting }
  | { ok: false; code: 'voice_setting_missing' | 'voice_setting_unreadable'; detail?: string };

/** La voix de l'espace, telle que la base la porte. */
export async function readVoiceSetting(
  db: AnyDrizzleDb,
  entityId: string,
): Promise<VoiceSettingRead> {
  const [row] = await db
    .select({ value: entitySettings.value })
    .from(entitySettings)
    .where(and(eq(entitySettings.entityId, entityId), eq(entitySettings.key, VOICE_SETTING_KEY)))
    .limit(1);
  if (!row) return { ok: false, code: 'voice_setting_missing' };
  try {
    return { ok: true, setting: parseVoiceSetting(row.value) };
  } catch (err) {
    return {
      ok: false,
      code: 'voice_setting_unreadable',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Écrit la voix de l'espace. La forme est validée ici aussi : une valeur que
 * `readVoiceSetting` ne saurait pas relire n'entre jamais en base. Que le
 * modèle et la voix soient OFFERTS se juge avant, contre ce que la source dit
 * (le runner, `checkVoiceOffered`) : la base ne connaît pas les fournisseurs.
 */
export async function writeVoiceSetting(
  db: AnyDrizzleDb,
  entityId: string,
  setting: VoiceSetting,
): Promise<void> {
  const value = JSON.stringify(VoiceSettingSchema.parse(setting));
  await db
    .insert(entitySettings)
    .values({ entityId, key: VOICE_SETTING_KEY, value })
    .onConflictDoUpdate({
      target: [entitySettings.entityId, entitySettings.key],
      set: { value, updatedAt: sql`now()` },
    });
}
