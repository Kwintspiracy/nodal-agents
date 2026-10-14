// policy.ts — CE QU'UNE COMMANDE CONFINÉE PEUT ÉCRIRE, en un seul endroit (#628).
//
// L'étape 1 du bac à sable confine les ÉCRITURES des commandes qu'un agent
// lance (`run_command`, `run_skill_script`, les commandes de preuve de
// `declare_verification`). La lecture et le réseau restent ouverts.
//
// Une commande confinée peut écrire dans quatre sortes de dossiers, et nulle
// part ailleurs :
//
//   1. les dossiers du job : ses workspaces (partagé compris) et le dossier
//      attaché à la demande — l'APPELANT les donne (`writableRoots`), parce
//      que lui seul sait pour quel job il lance la commande. Aucun état global
//      ne les devine ;
//   2. un temporaire PAR CONTENEUR, donc par job. Sous Windows, MXC le fournit
//      lui-même : il remplace TEMP/TMP et LOCALAPPDATA par un profil
//      AppContainer jetable, quoi qu'on lui passe (mesuré le 14/10 : TEMP
//      passé = un dossier du workspace, TEMP vu = `…\Packages\sandbox.{GUID}\AC\Temp`) ;
//   3. les DOSSIERS PERMIS PAR DÉFAUT (`defaultAllowedFolders()`, décision
//      D3) : les caches d'outils de Nodal, désignés aux outils par variable
//      d'environnement (`toolCacheEnv()`) — sans eux, `npm install` repart
//      d'un cache vide à chaque commande sous MXC, et échoue avec un message
//      trompeur sous Landlock (essais #731 et #733) — et les magasins de
//      modèles et d'images que Nodal trouve sur la machine pour ComfyUI,
//      Ollama, Docker et Hugging Face. Le réglage global, que l'utilisateur
//      pourra étendre, viendra avec l'écran qui le montre ; cette liste en est
//      la valeur pré-remplie ;
//   4. rien d'autre.

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Ce que l'appelant déclare pour UNE commande. */
export interface ConfinementPolicy {
  /**
   * Les dossiers du job où la commande peut écrire : ses workspaces et le
   * dossier attaché à la demande. Chemins absolus. Une liste VIDE est
   * permise et veut dire « nulle part hors du temporaire et des dossiers
   * permis par défaut » — jamais « partout ».
   */
  readonly writableRoots: readonly string[];
}

/**
 * Le dossier des caches d'outils, propriété de Nodal. Surchargeable pour les
 * tests (même convention que NODALAI_WORKSPACES_ROOT) : une suite qui lance
 * `npm install` confiné ne doit jamais écrire dans le vrai dossier personnel.
 */
export function toolCacheRoot(): string {
  return process.env['NODALAI_TOOL_CACHE_ROOT'] ?? join(homedir(), '.nodalai', 'tool-cache');
}

/**
 * LA liste des variables qui désignent un cache d'outil, et le sous-dossier
 * de `toolCacheRoot()` où chacune pointe. Un seul endroit, documenté ici :
 *
 *   - `npm_config_cache` : le cache de npm (et de npx). Sans lui, npm écrit
 *     dans `%LOCALAPPDATA%\npm-cache` ou `~/.npm`, hors des dossiers permis ;
 *   - `npm_config_store_dir`, `npm_config_cache_dir` : le magasin et le cache
 *     de métadonnées de pnpm, qui lit la configuration npm par environnement ;
 *   - `YARN_CACHE_FOLDER` : le cache de yarn 1 ;
 *   - `PIP_CACHE_DIR` : le cache de pip ;
 *   - `UV_CACHE_DIR` : le cache de uv.
 *
 * Posées pour TOUTE commande, confinée ou non : une commande ne change pas
 * de cache selon que le bac à sable est disponible. Un outil absent de cette
 * liste écrit où il veut, et sous confinement ce sera refusé : c'est le
 * signal pour l'ajouter ici, jamais pour élargir les dossiers permis.
 */
export const TOOL_CACHE_VARIABLES: Readonly<Record<string, string>> = {
  npm_config_cache: 'npm',
  npm_config_store_dir: 'pnpm-store',
  npm_config_cache_dir: 'pnpm-cache',
  YARN_CACHE_FOLDER: 'yarn',
  PIP_CACHE_DIR: 'pip',
  UV_CACHE_DIR: 'uv',
};

/** Les variables de cache, chacune vers son dossier, créés au besoin. */
export function toolCacheEnv(): Record<string, string> {
  const root = toolCacheRoot();
  const env: Record<string, string> = {};
  for (const [name, sub] of Object.entries(TOOL_CACHE_VARIABLES)) {
    const dir = join(root, sub);
    mkdirSync(dir, { recursive: true });
    env[name] = dir;
  }
  return env;
}

/**
 * Les dossiers réellement inscriptibles d'une commande, prêts pour un backend :
 * absolus, avec leur chemin RÉSOLU à côté quand il diffère (un workspace qui
 * est une jonction vers un autre disque ne s'écrit qu'à travers sa cible —
 * mesure 1i de l'essai MXC : une jonction préexistante vers un dossier non
 * permis ne laisse pas passer l'écriture), sans doublon. Les dossiers permis
 * par défaut sont ajoutés ici, pour tous les appelants.
 *
 * Un chemin relatif est une erreur de l'appelant : on échoue fort plutôt que
 * de le résoudre contre le dossier courant du runner (invariant #4).
 */
export function resolveWritableRoots(policy: ConfinementPolicy): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string): void => {
    const key = process.platform === 'win32' ? p.toLowerCase() : p;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  const defaults = defaultAllowedFolders().map((f) => f.path);
  for (const root of [...policy.writableRoots, ...defaults]) {
    if (!isAbsolute(root)) {
      throw new Error(`SANDBOX_ROOT_NOT_ABSOLUTE: ${root}`);
    }
    const abs = resolve(root);
    add(abs);
    try {
      add(realpathSync.native(abs));
    } catch {
      // Un dossier qui n'existe pas encore n'a pas de chemin résolu : on le
      // déclare tel quel, MXC l'accepte sans le créer (mesure 5).
    }
  }
  return out;
}

// ─── Les dossiers permis par défaut (décision D3) ────────────────────────────

/** D'où vient un dossier permis par défaut — pour l'écran qui les montrera. */
export type AllowedFolderSource = 'tool-cache' | 'comfyui' | 'ollama' | 'huggingface' | 'docker';

export interface AllowedFolder {
  readonly path: string;
  readonly source: AllowedFolderSource;
}

/** Ce que la détection lit de la machine — injectable pour les tests. */
export interface MachineView {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly platform: NodeJS.Platform;
}

const thisMachine = (): MachineView => ({
  env: process.env,
  home: homedir(),
  platform: process.platform,
});

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Le dossier de ComfyUI Desktop, tel que SA configuration le dit
 * (`config.json`, clé `basePath`) : `%APPDATA%\ComfyUI` sous Windows,
 * `~/Library/Application Support/ComfyUI` sous macOS, `~/.config/ComfyUI`
 * (ou `$XDG_CONFIG_HOME/ComfyUI`) sous Linux. Une installation portable, qui
 * n'écrit pas de configuration, n'est pas trouvée : rien n'est deviné.
 */
function comfyuiBase(m: MachineView): string | null {
  const configDir =
    m.platform === 'win32'
      ? m.env['APPDATA'] && join(m.env['APPDATA'], 'ComfyUI')
      : m.platform === 'darwin'
        ? join(m.home, 'Library', 'Application Support', 'ComfyUI')
        : join(m.env['XDG_CONFIG_HOME'] ?? join(m.home, '.config'), 'ComfyUI');
  if (!configDir) return null;
  try {
    const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')) as {
      basePath?: unknown;
    };
    return typeof config.basePath === 'string' && isAbsolute(config.basePath)
      ? config.basePath
      : null;
  } catch {
    return null;
  }
}

/**
 * Les candidats de chaque programme, d'après SA configuration : d'abord sa
 * variable d'environnement, sinon son emplacement par défaut documenté.
 *   - ComfyUI : `<basePath>/models` et `<basePath>/output` (modèles, images) ;
 *   - Ollama : `OLLAMA_MODELS`, sinon `~/.ollama/models` (et, sous Linux,
 *     le magasin du service système `/usr/share/ollama/.ollama/models`) ;
 *   - Hugging Face : `HF_HOME`, sinon `$XDG_CACHE_HOME/huggingface` ou
 *     `~/.cache/huggingface` ; plus `HF_HUB_CACHE` / `HUGGINGFACE_HUB_CACHE`
 *     quand ils pointent ailleurs ;
 *   - Docker : le magasin d'images de Docker Desktop
 *     (`%LOCALAPPDATA%\Docker\wsl` sous Windows,
 *     `~/Library/Containers/com.docker.docker/Data/vms` sous macOS) ou du
 *     Docker sans root sous Linux (`$XDG_DATA_HOME/docker`, sinon
 *     `~/.local/share/docker`). Pas `~/.docker` : c'est la configuration du
 *     client, identifiants compris, pas un magasin d'images.
 */
function storeCandidates(m: MachineView): AllowedFolder[] {
  const out: AllowedFolder[] = [];
  const comfy = comfyuiBase(m);
  if (comfy) {
    out.push({ path: join(comfy, 'models'), source: 'comfyui' });
    out.push({ path: join(comfy, 'output'), source: 'comfyui' });
  }
  out.push({
    path: m.env['OLLAMA_MODELS'] ?? join(m.home, '.ollama', 'models'),
    source: 'ollama',
  });
  if (m.platform === 'linux') {
    out.push({ path: '/usr/share/ollama/.ollama/models', source: 'ollama' });
  }
  const cacheHome =
    m.platform === 'linux' && m.env['XDG_CACHE_HOME']
      ? m.env['XDG_CACHE_HOME']
      : join(m.home, '.cache');
  out.push({ path: m.env['HF_HOME'] ?? join(cacheHome, 'huggingface'), source: 'huggingface' });
  for (const name of ['HF_HUB_CACHE', 'HUGGINGFACE_HUB_CACHE']) {
    const p = m.env[name];
    if (p) out.push({ path: p, source: 'huggingface' });
  }
  if (m.platform === 'win32') {
    if (m.env['LOCALAPPDATA']) {
      out.push({ path: join(m.env['LOCALAPPDATA'], 'Docker', 'wsl'), source: 'docker' });
    }
  } else if (m.platform === 'darwin') {
    out.push({
      path: join(m.home, 'Library', 'Containers', 'com.docker.docker', 'Data', 'vms'),
      source: 'docker',
    });
  } else {
    out.push({
      path: join(m.env['XDG_DATA_HOME'] ?? join(m.home, '.local', 'share'), 'docker'),
      source: 'docker',
    });
  }
  return out;
}

/**
 * LA liste des dossiers permis par défaut (D3) : le cache d'outils de Nodal
 * (créé ici, il est à Nodal), puis les magasins de modèles et d'images que
 * Nodal TROUVE sur cette machine — seulement ceux qui existent, absolus, sans
 * doublon. C'est la valeur pré-remplie du réglage global que l'écran
 * montrera et que l'utilisateur pourra étendre.
 */
export function defaultAllowedFolders(machine: MachineView = thisMachine()): AllowedFolder[] {
  const cache = toolCacheRoot();
  mkdirSync(cache, { recursive: true });
  const out: AllowedFolder[] = [{ path: cache, source: 'tool-cache' }];
  const seen = new Set<string>([key(cache, machine.platform)]);
  for (const c of storeCandidates(machine)) {
    if (!isAbsolute(c.path) || !existsSync(c.path) || !isDirectory(c.path)) continue;
    const k = key(c.path, machine.platform);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

function key(path: string, platform: NodeJS.Platform): string {
  const r = resolve(path);
  return platform === 'win32' ? r.toLowerCase() : r;
}
