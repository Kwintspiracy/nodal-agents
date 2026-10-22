// repos/llm-keys.ts — enregistrer la clé d'un fournisseur de modèles dans un espace.
//
// L'écriture de `createLlmKeyAction` (apps/web), sortie de l'action pour que le
// banc v2 crée la clé de son instance par le même chemin (règle 11). La clé est
// chiffrée ici, avec la clé maîtresse de l'instance (@nodal-agents/secrets) :
// aucun appelant ne peut écrire un secret en clair.

import { and, eq } from 'drizzle-orm';
import { encrypt, last4 } from '@nodal-agents/secrets';
import type { AnyDrizzleDb } from '../client.ts';
import { entityLlmKeys } from '../schema/llm_keys.ts';

export interface CreateLlmKeyInput {
  readonly provider: string;
  /** En clair ; chiffré avant l'écriture. Vide : un serveur local sans clé. */
  readonly apiKey: string;
  readonly baseUrl?: string | null;
  readonly nickname?: string | null;
  readonly contextWindow?: number | null;
  readonly isActive: boolean;
}

/**
 * Une clé par fournisseur et par espace : une seule clé sert autant de modèles
 * et d'agents qu'on veut, un doublon n'ajoute que de la confusion.
 */
export async function createLlmKeyRepo(
  db: AnyDrizzleDb,
  entityId: string,
  input: CreateLlmKeyInput,
): Promise<{ id: string } | { error: 'provider_exists' }> {
  const [dup] = await db
    .select({ id: entityLlmKeys.id })
    .from(entityLlmKeys)
    .where(and(eq(entityLlmKeys.entityId, entityId), eq(entityLlmKeys.provider, input.provider)))
    .limit(1);
  if (dup) return { error: 'provider_exists' };

  const [row] = await db
    .insert(entityLlmKeys)
    .values({
      entityId,
      provider: input.provider,
      apiKey: encrypt(input.apiKey),
      apiKeyLast4: last4(input.apiKey),
      baseUrl: input.baseUrl ?? null,
      nickname: input.nickname ?? null,
      contextWindow: input.contextWindow ?? null,
      isActive: input.isActive,
    })
    .returning({ id: entityLlmKeys.id });
  if (!row) throw new Error('llm_key_insert_no_row: the insert returned no row');
  return { id: row.id };
}
