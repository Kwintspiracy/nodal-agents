// repos/verification-surfaces.ts — lire le réglage « surfaces sous
// vérification » d'un espace (D8, plan « Vérifier & Corriger », T15).
//
// Ne rattrape RIEN (invariant #4). Un `.catch(() => DEFAULT_VERIFICATION_SURFACES)`
// paraîtrait inoffensif — le défaut est « tout coché » — mais il masquerait une
// base cassée pendant que la preuve tourne, et une entité introuvable
// deviendrait « tout vérifié » au lieu d'une erreur. La version précédente du
// frein d'urgence (apps/runner/src/approvals/rules.ts) rendait false sur
// erreur de base : une base injoignable relâchait le frein en silence. Même
// leçon ici, dans l'autre sens.

import { eq } from 'drizzle-orm';
import { parseVerificationSurfaces, type VerificationSurfaces } from '@nodal-agents/shared';
import type { AnyDrizzleDb } from '../client.ts';
import { entities } from '../schema/index.ts';

/**
 * Le réglage de l'espace, parsé. Lève `ENTITY_NOT_FOUND` si l'entité n'existe
 * pas ; laisse remonter toute erreur de base. Jamais un objet par défaut sur
 * erreur — le défaut ne couvre que les CHAMPS absents d'une ligne qui existe.
 */
export async function getVerificationSurfaces(
  db: AnyDrizzleDb,
  entityId: string,
): Promise<VerificationSurfaces> {
  const [row] = await db
    .select({ verificationSurfaces: entities.verificationSurfaces })
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);
  if (!row) throw new Error(`ENTITY_NOT_FOUND: ${entityId}`);
  return parseVerificationSurfaces(row.verificationSurfaces);
}
