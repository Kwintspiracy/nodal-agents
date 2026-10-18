// nodal-home.ts — LE dossier de Nodal, et tout ce qui vit dessous, en un seul endroit.
//
// POURQUOI (17/10/2026). Le dossier de Nodal était `homedir()/.nodalai`, recopié
// à la main dans une vingtaine de fichiers (CLI, secrets, web, bac à sable,
// banc…), sans réglage. Deux installations côte à côte étaient impossibles :
// une seconde instance lisait la configuration, la clé maîtresse et la base de
// la première. Le banc v2 en a besoin (une campagne = une Nodal neuve, jetée
// ensuite), et un utilisateur aussi (une instance d'essai à côté de la sienne).
//
// LA RÈGLE. `NODALAI_HOME` (chemin ABSOLU) désigne le dossier ; absent, c'est
// `homedir()/.nodalai`. Tout chemin sous ce dossier se calcule ICI. Les
// variables plus étroites qui existaient (`NODALAI_WORKSPACES_ROOT`…) gardent
// la priorité sur leur seul sous-dossier : `NODAL_HOME_OVERRIDES` les liste, et
// c'est la seule table.
//
// ÉCHEC FORT (invariant #4). Une valeur vide, relative, ou « relative au
// lecteur » sous Windows (`\x`) est refusée avec un message qui dit quoi faire :
// jamais de repli silencieux sur `~/.nodalai`, qui ferait tourner la seconde
// instance sur les données de la première. Un dossier impossible à créer est
// refusé par `ensureNodalHome`.
//
// Module Node uniquement (`node:os`, `node:fs`) : il est exposé par le sous-chemin
// `@nodal-agents/shared/nodal-home`, jamais par l'index, que des composants
// clients importent.

import { createHash } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/** La variable qui déplace le dossier de Nodal. */
export const NODALAI_HOME_ENV = 'NODALAI_HOME';

/** Le nom du dossier par défaut, sous le dossier personnel de l'utilisateur. */
const DEFAULT_DIR_NAME = '.nodalai';

/**
 * Les entrées du dossier qu'une variable plus étroite peut envoyer ailleurs.
 * Elle a la priorité sur `NODALAI_HOME` pour SON entrée seulement ; les autres
 * suivent le dossier.
 */
export const NODAL_HOME_OVERRIDES = {
  'config.json': 'NODALAI_CONFIG_PATH',
  workspaces: 'NODALAI_WORKSPACES_ROOT',
  checkpoints: 'NODALAI_CHECKPOINTS_ROOT',
  sandbox: 'NODALAI_SANDBOX_DIR',
  'tool-cache': 'NODALAI_TOOL_CACHE_ROOT',
} as const;

export type NodalHomeEntry = keyof typeof NODAL_HOME_OVERRIDES;

/** Une variable de chemin de Nodal mal réglée. Le message dit laquelle et quoi faire. */
export class NodalHomeError extends Error {
  readonly code = 'NODALAI_HOME_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'NodalHomeError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function pathFor(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

/**
 * Un chemin absolu ET complet. Sous Windows, `isAbsolute('\\x')` est vrai alors
 * que ce chemin dépend du lecteur courant : il faut une lettre de lecteur ou
 * un chemin UNC.
 */
function isFullyQualified(value: string, platform: NodeJS.Platform): boolean {
  if (!pathFor(platform).isAbsolute(value)) return false;
  return platform !== 'win32' || /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(value);
}

/** Lit une variable de chemin : absente → `undefined`, invalide → erreur nommée. */
function readPathVariable(env: Env, name: string, platform: NodeJS.Platform): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  if (raw.trim() === '') {
    throw new NodalHomeError(
      `${name} is set but empty. Unset it to use the default, or set it to an absolute path.`,
    );
  }
  if (!isFullyQualified(raw, platform)) {
    throw new NodalHomeError(
      `${name} must be an absolute path, got "${raw}". ` +
        'A relative path would depend on the folder Nodal is started from.',
    );
  }
  return pathFor(platform).resolve(raw);
}

/** Le dossier de Nodal quand `NODALAI_HOME` n'est pas posée. */
export function defaultNodalHome(
  userHome: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return pathFor(platform).join(userHome, DEFAULT_DIR_NAME);
}

/** Le dossier de Nodal de CE processus : `NODALAI_HOME`, ou `~/.nodalai`. */
export function nodalHome(
  env: Env = process.env,
  userHome: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return readPathVariable(env, NODALAI_HOME_ENV, platform) ?? defaultNodalHome(userHome, platform);
}

/** Un chemin sous le dossier de Nodal (`pids`, `logs`, `secrets.key`…). */
export function nodalHomePath(...segments: string[]): string {
  return pathFor(process.platform).join(nodalHome(), ...segments);
}

/**
 * Une entrée que sa variable étroite peut déplacer (`NODAL_HOME_OVERRIDES`) :
 * la variable si elle est posée, sinon l'entrée sous le dossier de Nodal.
 */
export function nodalHomeEntry(
  name: NodalHomeEntry,
  env: Env = process.env,
  userHome: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return (
    readPathVariable(env, NODAL_HOME_OVERRIDES[name], platform) ??
    pathFor(platform).join(nodalHome(env, userHome, platform), name)
  );
}

/**
 * Relit `NODALAI_HOME` et chaque variable de `NODAL_HOME_OVERRIDES`, et lève à
 * la première mal réglée. Pour un point d'entrée qui veut refuser AVANT de
 * démarrer quoi que ce soit, plutôt qu'au premier chemin calculé.
 */
export function assertNodalHomeSettings(env: Env = process.env): void {
  nodalHome(env);
  for (const name of Object.keys(NODAL_HOME_OVERRIDES) as NodalHomeEntry[]) {
    nodalHomeEntry(name, env);
  }
}

/**
 * Crée le dossier de Nodal s'il manque, et refuse en le disant quand c'est
 * impossible (droits, lecteur absent, un FICHIER à ce chemin).
 */
export function ensureNodalHome(dir: string = nodalHome()): string {
  try {
    mkdirSync(dir, { recursive: true });
    if (!statSync(dir).isDirectory()) throw new Error('a file is in the way');
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new NodalHomeError(
      `Nodal's home folder ${dir} cannot be created (${why}). ` +
        `Fix the folder, or point ${NODALAI_HOME_ENV} at an absolute path you can write to.`,
    );
  }
  return dir;
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const p = pathFor(platform);
  const na = p.resolve(a);
  const nb = p.resolve(b);
  return platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/**
 * Le nom court d'une instance, pour ce qui est UNIQUE par utilisateur sur la
 * machine (l'inscription au démarrage). `null` pour le dossier par défaut :
 * l'installation qui existait avant ce réglage garde ses noms, sinon son
 * inscription déjà posée deviendrait invisible. Toute autre instance reçoit
 * 8 caractères tirés de son chemin : stables, et distincts d'une instance à
 * l'autre.
 */
export function nodalInstanceId(
  home: string = nodalHome(),
  userHome: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (samePath(home, defaultNodalHome(userHome, platform), platform)) return null;
  const p = pathFor(platform).resolve(home);
  const key = platform === 'win32' ? p.toLowerCase() : p;
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}
