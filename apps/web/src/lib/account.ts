import 'server-only';

// account.ts — QUI EST CONNECTÉ, lu une seule fois par rendu du tableau de bord
// (#230, planches du 19/09/2026).
//
// Le rail dessine un rond avec l'INITIALE de la personne, et le bloc de compte
// écrit son courriel en entier. Les deux tenaient leur réponse de la même
// requête, écrite dans `UserMenu` ; le rail ne pouvant pas lire dans son
// enfant, la lecture remonte ici et le layout la fait UNE fois, puis la
// distribue. L'alternative — une deuxième requête pour une seule lettre —
// aurait payé deux allers-retours pour le même fait.

import { headers } from 'next/headers';
import { users, eq } from '@nodal-agents/db';
import { getDb, requireUserWithEntity } from './server.ts';
import { env } from './env.ts';

/**
 * Le courriel de la personne connectée, ou `null`.
 *
 * `null` hors du mode `local-auth` : en confiance locale et sous jeton d'API,
 * il n'y a PERSONNE — pas un nom qu'on n'arrive pas à lire, mais pas de compte
 * du tout. Le rail et le bloc de compte le disent alors chacun à leur façon,
 * sans rien inventer (invariant #4).
 */
export async function accountEmail(): Promise<string | null> {
  if (env.AUTH_MODE !== 'local-auth') return null;
  try {
    const h = await headers();
    const req = new Request('http://localhost/', { headers: h });
    const session = await requireUserWithEntity(req);
    const row = await getDb()
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    return row[0]?.email ?? null;
  } catch {
    // La page du tableau de bord est déjà gardée par son layout : un échec ici
    // veut dire qu'on ne sait pas qui c'est, pas qu'il faut refuser la page.
    return null;
  }
}

/**
 * L'INITIALE que le rond du rail affiche, ou `null` quand il n'y a personne à
 * nommer.
 *
 * La PREMIÈRE lettre du courriel, en capitale — ce que la planche dessine
 * (« Q » pour quentinbeau@gmail.com). Un courriel qui commencerait par un
 * chiffre ou un point rend ce caractère-là : c'est ce que la personne voit
 * écrit, et le déguiser serait une supposition de plus.
 */
export function initialOf(email: string | null): string | null {
  const premier = (email ?? '').trim().charAt(0);
  return premier === '' ? null : premier.toUpperCase();
}
