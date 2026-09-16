// scripts/lib/sonde.mjs — la seule partie de la garde qui touche le réseau.
//
// Le VERDICT vit dans `live-stack.mjs` et reste pur. Ici il n'y a qu'une
// question posée à un port, et elle est isolée pour une raison : elle se teste
// contre un vrai serveur, ce qu'aucune lecture de source ne remplace.

import { FAMILLES_SONDEES, verdictDuneSonde } from './live-stack.mjs';

/**
 * Est-ce que quelqu'un sert sur ce port ?
 *
 * Les DEUX familles d'adresses sont essayées. `localhost` ne suffit pas : selon
 * la machine il résout en 127.0.0.1 ou en ::1, et une stack liée à l'autre
 * famille refusait la connexion — elle était donc déclarée absente, et le build
 * la tuait.
 *
 * `redirect: 'manual'` est essentiel. Par défaut `fetch` SUIT la redirection :
 * un serveur qui répond 307 vers une adresse fermée faisait jeter un
 * `ECONNREFUSED` venu de la SECONDE requête, et la stack bien vivante qui
 * venait de répondre passait pour absente. Une réponse 3xx est une réponse.
 */
export async function sonderUnPort(port, { familles = FAMILLES_SONDEES, delaiMs = 1500 } = {}) {
  const erreurs = await Promise.all(
    familles.map(async (hote) => {
      const autorite = hote.includes(':') ? `[${hote}]` : hote;
      try {
        await fetch(`http://${autorite}:${port}/api/health`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(delaiMs),
        });
        return null;
      } catch (err) {
        return err;
      }
    }),
  );
  return { port, vivant: verdictDuneSonde(erreurs) };
}
