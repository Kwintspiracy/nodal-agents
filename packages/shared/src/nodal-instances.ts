// nodal-instances.ts — les instances de Nodal de CET utilisateur, sur cette machine.
//
// POURQUOI (18/10/2026, revue de #787). Avec NODALAI_HOME, plusieurs instances
// vivent côte à côte. Le bac à sable de chacune doit refuser à ses commandes
// confinées les données de TOUTES (secrets.key, config.json, pg-data, et les
// dossiers qu'une variable étroite envoie ailleurs) — pas seulement les siennes
// et celles de `~/.nodalai`. Une instance ne peut refuser que ce qu'elle
// connaît : il faut donc un endroit où chacune se déclare.
//
// LE REGISTRE. Un dossier à un endroit fixe, qui ne dépend d'AUCUNE variable de
// Nodal : `<dossier personnel>/.nodalai-instances/`. Un fichier par instance,
// nommé d'après son dossier : deux `up` simultanés écrivent deux fichiers
// différents, sans verrou ni course. `up` y inscrit son dossier et les chemins
// résolus de ses entrées (`NODAL_HOME_OVERRIDES`) ; `reset` retire le sien.
// Une entrée périmée (dossier effacé à la main) ne coûte rien : refuser un
// chemin absent est sans effet.
//
// Il ne contient que des CHEMINS, aucun secret. Un fichier illisible ou mal
// formé est une erreur nommée, jamais une entrée ignorée (invariant #4) : en
// ignorer une laisserait les secrets de cette instance lisibles.

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { z } from 'zod';
import { NODAL_HOME_OVERRIDES, type NodalHomeEntry, nodalHome, nodalHomeEntry } from './nodal-home';

/** Le nom du dossier du registre, sous le dossier personnel de l'utilisateur. */
const REGISTRY_DIR_NAME = '.nodalai-instances';

type Env = Readonly<Record<string, string | undefined>>;

const pathFor = (platform: NodeJS.Platform): typeof posix => (platform === 'win32' ? win32 : posix);

/** Un fichier du registre illisible ou mal formé. */
export class NodalInstancesError extends Error {
  readonly code = 'NODALAI_INSTANCES_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'NodalInstancesError';
  }
}

const AbsolutePath = z.string().min(1);

const RecordSchema = z
  .object({
    home: AbsolutePath,
    // Les clés de NODAL_HOME_OVERRIDES ; `satisfies` plus bas fait rougir le
    // typecheck si la table gagne une entrée que ce schéma ignore.
    entries: z
      .object({
        'config.json': AbsolutePath,
        workspaces: AbsolutePath,
        checkpoints: AbsolutePath,
        sandbox: AbsolutePath,
        'tool-cache': AbsolutePath,
      } satisfies Record<NodalHomeEntry, typeof AbsolutePath>)
      .strict(),
    registeredAt: z.string(),
  })
  .strict();

/** Ce qu'une instance déclare : son dossier, et où sont réellement ses entrées. */
export type NodalInstanceRecord = z.infer<typeof RecordSchema>;

/** Le dossier du registre. */
export function nodalInstancesDir(
  userHome: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return pathFor(platform).join(userHome, REGISTRY_DIR_NAME);
}

/** L'instance que ces variables désignent, entrées résolues. */
export function nodalInstanceRecord(
  env: Env = process.env,
  userHome: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  now: Date = new Date(),
): NodalInstanceRecord {
  const entries = {} as Record<NodalHomeEntry, string>;
  for (const name of Object.keys(NODAL_HOME_OVERRIDES) as NodalHomeEntry[]) {
    entries[name] = nodalHomeEntry(name, env, userHome, platform);
  }
  return { home: nodalHome(env, userHome, platform), entries, registeredAt: now.toISOString() };
}

function recordFile(home: string, userHome: string, platform: NodeJS.Platform): string {
  const p = pathFor(platform);
  const key = platform === 'win32' ? p.resolve(home).toLowerCase() : p.resolve(home);
  const id = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return p.join(nodalInstancesDir(userHome, platform), `${id}.json`);
}

/**
 * Inscrit l'instance de ces variables (remplace son entrée si elle existe).
 * Écrit à côté puis renomme : un lecteur ne voit jamais un fichier à moitié
 * écrit. Rend le chemin du fichier.
 */
export function registerNodalInstance(
  env: Env = process.env,
  userHome: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  now: Date = new Date(),
): string {
  const record = nodalInstanceRecord(env, userHome, platform, now);
  const file = recordFile(record.home, userHome, platform);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(nodalInstancesDir(userHome, platform), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    const why = err instanceof Error ? err.message : String(err);
    throw new NodalInstancesError(
      `Cannot register this instance in ${nodalInstancesDir(userHome, platform)} (${why}). ` +
        'Without it, the sandbox of another Nodal instance on this machine cannot refuse ' +
        'its commands access to this one’s secrets.',
    );
  }
  return file;
}

/** Retire l'entrée de l'instance de ces variables ; absente, rien à faire. */
export function unregisterNodalInstance(
  env: Env = process.env,
  userHome: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): void {
  rmSync(recordFile(nodalHome(env, userHome, platform), userHome, platform), { force: true });
}

/**
 * Toutes les instances inscrites. Pas de registre : aucune. Un fichier
 * illisible, mal formé, ou dont un chemin n'est pas absolu : erreur nommée.
 */
export function readNodalInstances(
  userHome: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): NodalInstanceRecord[] {
  const p = pathFor(platform);
  const dir = nodalInstancesDir(userHome, platform);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new NodalInstancesError(`Cannot list ${dir}: ${(err as Error).message}`);
  }
  const out: NodalInstanceRecord[] = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const file = p.join(dir, name);
    let record: NodalInstanceRecord;
    try {
      record = RecordSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    } catch (err) {
      throw new NodalInstancesError(
        `${file} is not a valid Nodal instance entry (${(err as Error).message}). ` +
          'Delete it, then run `nodal-agents up` again for that instance.',
      );
    }
    const paths = [record.home, ...Object.values(record.entries)];
    const relative = paths.find((x) => !p.isAbsolute(x));
    if (relative !== undefined) {
      throw new NodalInstancesError(`${file} holds a path that is not absolute: "${relative}".`);
    }
    out.push(record);
  }
  return out;
}
