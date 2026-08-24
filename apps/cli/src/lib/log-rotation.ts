// log-rotation.ts — les logs de service ne doivent pas grossir sans limite.
//
// Constat (24/08) : runner.log et web.log sont ouverts en append à chaque
// boot et ne tournaient JAMAIS — 59 Mo + 21 Mo en deux mois d'usage solo sur
// l'install de référence, et rien ne bornait la suite. Une fuite lente
// installée chez chaque utilisateur.
//
// Politique : rotation AU BOOT, par taille. Au-delà du plafond, le fichier
// devient `<name>.log.1` (l'archive précédente est remplacée) et un fichier
// neuf repart. Deux générations = assez pour diagnostiquer « ce qui vient de
// se passer » sans qu'aucun disque ne se remplisse en silence. Pas de
// rotation en cours de run : le fd est tenu par le service détaché, le
// remplacer sous lui perdrait des écritures.

import { existsSync, renameSync, rmSync, statSync } from 'fs';

/** 20 Mo par service — deux mois d'usage intensif tiennent largement dedans. */
export const LOG_ROTATE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Fait tourner `logFile` s'il dépasse `maxBytes`. Retourne true si une
 * rotation a eu lieu. N'empêche JAMAIS le boot : un échec (verrou antivirus
 * Windows sur le fichier, droit manquant) est signalé sur stderr et le log
 * continue en append — la prochaine rotation réessaiera.
 */
export function rotateLogIfNeeded(
  logFile: string,
  maxBytes: number = LOG_ROTATE_MAX_BYTES,
): boolean {
  try {
    if (!existsSync(logFile)) return false;
    if (statSync(logFile).size < maxBytes) return false;
    const archived = `${logFile}.1`;
    rmSync(archived, { force: true });
    renameSync(logFile, archived);
    return true;
  } catch (err) {
    console.warn(
      `[nodalai] log rotation skipped for ${logFile}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
