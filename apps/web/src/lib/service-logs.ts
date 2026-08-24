// service-logs.ts — lecture/effacement des logs de SERVICE depuis le dashboard.
//
// À ne pas confondre avec la page « Logs » historique (l'audit des tool
// calls) : ici il s'agit des fichiers ~/.nodalai/logs/<svc>.log — stdout des
// processus runner et web, leurs erreurs, leurs traces. Jusqu'ici lisibles
// uniquement au CLI (`nodal-agents logs`) ou en ouvrant les fichiers
// (constat Quentin 24/08).
//
// Sécurité : le nom de service est un ENUM fermé ('runner' | 'web') et la
// génération un enum fermé — aucun chemin ne vient jamais du client, aucune
// traversée possible. Le répertoire est celui du CLI (~/.nodalai/logs), le
// web tournant par construction sur la même machine que les services.

import { existsSync, statSync, openSync, readSync, closeSync, truncateSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SERVICE_LOG_NAMES = ['runner', 'web'] as const;
export type ServiceLogName = (typeof SERVICE_LOG_NAMES)[number];
export type ServiceLogGeneration = 'current' | 'archive';

/** 64 Ko de fin de fichier — assez pour diagnostiquer, jamais un transfert lourd. */
export const SERVICE_LOG_TAIL_BYTES = 64 * 1024;

export function serviceLogsDir(): string {
  return join(homedir(), '.nodalai', 'logs');
}

export function serviceLogPath(
  service: ServiceLogName,
  generation: ServiceLogGeneration,
  baseDir: string = serviceLogsDir(),
): string {
  return join(baseDir, `${service}.log${generation === 'archive' ? '.1' : ''}`);
}

export interface ServiceLogTail {
  exists: boolean;
  sizeBytes: number;
  /** Les derniers `maxBytes` octets, décodés en UTF-8 (début possiblement tronqué au milieu d'une ligne). */
  tail: string;
  /** True quand le fichier dépasse la fenêtre lue — le début n'est pas montré. */
  truncated: boolean;
}

export function readServiceLogTail(
  service: ServiceLogName,
  generation: ServiceLogGeneration,
  baseDir: string = serviceLogsDir(),
  maxBytes: number = SERVICE_LOG_TAIL_BYTES,
): ServiceLogTail {
  const path = serviceLogPath(service, generation, baseDir);
  if (!existsSync(path)) return { exists: false, sizeBytes: 0, tail: '', truncated: false };
  const size = statSync(path).size;
  const readBytes = Math.min(size, maxBytes);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(readBytes);
    readSync(fd, buf, 0, readBytes, size - readBytes);
    return {
      exists: true,
      sizeBytes: size,
      tail: buf.toString('utf8'),
      truncated: size > maxBytes,
    };
  } finally {
    closeSync(fd);
  }
}

export interface ServiceLogClearResult {
  /** Octets libérés (fichier courant tronqué + archive supprimée). */
  freedBytes: number;
}

/**
 * Vide le log courant (truncate — le service garde son descripteur en append,
 * les écritures suivantes repartent au début) et supprime l'archive `.1`.
 * Laisse remonter l'erreur si Windows refuse (verrou) : l'appelant la montre
 * telle quelle plutôt que de prétendre avoir nettoyé.
 */
export function clearServiceLog(
  service: ServiceLogName,
  baseDir: string = serviceLogsDir(),
): ServiceLogClearResult {
  let freed = 0;
  const current = serviceLogPath(service, 'current', baseDir);
  if (existsSync(current)) {
    freed += statSync(current).size;
    truncateSync(current, 0);
  }
  const archive = serviceLogPath(service, 'archive', baseDir);
  if (existsSync(archive)) {
    freed += statSync(archive).size;
    rmSync(archive, { force: true });
  }
  return { freedBytes: freed };
}
