/**
 * sandbox-copy.ts — les MOTS de l'écran du bac à sable (#876).
 *
 * Le runner rend des codes et des chemins (GET /api/sandbox, invariant #2) ;
 * c'est ici, et nulle part ailleurs, qu'ils deviennent des phrases. Un code que
 * cette table ne connaît pas s'affiche tel quel : jamais une phrase inventée à
 * sa place.
 *
 * Un module sans directive : la section (client), le bandeau (serveur) et les
 * lignes de Réglages le lisent.
 */

import type { AllowedFolderSourceKey, SandboxAgent, SandboxState } from '@nodal-agents/shared';
import { CLI_RUNTIME_LABELS, isCliRuntimeValue } from './cli-runtimes.ts';

// ─── Le système, le moteur ───────────────────────────────────────────────────

/** Le nom du système du runner, tel qu'on le dit. */
export function osName(platform: string): string {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  return platform;
}

/** Le moteur du bac à sable, tel qu'on le dit ; un code inconnu, tel quel. */
const ENGINE_WORDS: Record<string, string> = {
  'mxc-processcontainer': 'Windows container (MXC)',
};

export function engineWords(backend: string): string {
  return ENGINE_WORDS[backend] ?? backend;
}

/** Pourquoi le bac à sable n'est pas là, en clair. */
const UNAVAILABLE_WORDS: Record<string, string> = {
  SANDBOX_NOT_IMPLEMENTED: 'Not available on this system yet',
  SANDBOX_BACKEND_MISSING: 'Its package is missing from this install',
  SANDBOX_PLATFORM_UNSUPPORTED: 'This Windows build does not support it',
  SANDBOX_SELF_TEST_FAILED: 'Its self-test failed on this machine',
  SANDBOX_BROKER_START_FAILED: 'Its container host could not start',
  SANDBOX_BROKER_NODE_UNAVAILABLE: 'Its Node runtime could not be fetched',
  SANDBOX_PROXY_UNREACHABLE: 'Its network proxy cannot be reached',
  SANDBOX_NODAL_PORTS_UNKNOWN: "Nodal's own ports are unknown",
};

export function unavailableWords(code: string): string {
  return UNAVAILABLE_WORDS[code] ?? code;
}

// ─── Le régime ───────────────────────────────────────────────────────────────

/** Ce que l'interrupteur et la sonde donnent ensemble, en un mot. */
export type SandboxRegime = 'active' | 'off' | 'unavailable';

export function sandboxRegime(state: Pick<SandboxState, 'status' | 'enabled'>): SandboxRegime {
  if (state.status.state !== 'available') return 'unavailable';
  return state.enabled ? 'active' : 'off';
}

/** Le bac à sable n'existe pas encore sur ce système : les contrôles sont éteints. */
export function notOnThisSystem(state: Pick<SandboxState, 'status'>): boolean {
  return state.status.state === 'unavailable' && state.status.code === 'SANDBOX_NOT_IMPLEMENTED';
}

/** La carte d'état : sa phrase, et les faits de son pied. */
export interface StateCardWords {
  title: string;
  body: string;
  /** ENGINE */
  engine: string;
  /** APPLIES, quand le bac à sable confine. */
  applies?: string;
  /** RESULTS : le code que chaque résultat de commande porte, quand il ne confine pas. */
  results?: string;
}

export function stateCardWords(
  state: Pick<SandboxState, 'status' | 'enabled' | 'platform'>,
): StateCardWords {
  const status = state.status;
  if (status.state === 'available') {
    return state.enabled
      ? {
          title: 'Commands are confined',
          body: 'Each command runs in its own container. It writes only in the folders below.',
          engine: engineWords(status.backend),
          applies: 'from the next command',
        }
      : {
          title: 'Commands are not confined',
          body: "They can write anywhere you can and read Nodal's data. Turn it on to confine the next one.",
          engine: `${engineWords(status.backend)}, ready`,
          results: 'SANDBOX_DISABLED',
        };
  }
  if (notOnThisSystem(state)) {
    const os = osName(state.platform);
    return {
      title: `Not available on ${os} yet`,
      body: `Commands run without confinement on this system. The ${os} sandbox comes in a later version.`,
      engine: 'none on this system',
      results: status.code,
    };
  }
  return {
    title: 'The sandbox is unavailable',
    body: `${unavailableWords(status.code)}. Commands run without confinement until it works again.`,
    engine: 'not ready on this machine',
    results: status.code,
  };
}

// ─── Le périmètre ────────────────────────────────────────────────────────────

/** Une case du périmètre : sa valeur, sa phrase, et si la valeur alerte. */
export interface PerimeterWords {
  value: string;
  subtle: string;
  tone: 'default' | 'warn';
}

export function perimeterWords(
  state: Pick<SandboxState, 'status' | 'enabled' | 'platform' | 'writableFolderCount' | 'network'>,
): { write: PerimeterWords; read: PerimeterWords; network: PerimeterWords } {
  const regime = sandboxRegime(state);
  if (regime === 'active') {
    const n = state.writableFolderCount;
    const portsKnown = 'deniedPorts' in state.network;
    return {
      write: {
        value: `${n} folder${n === 1 ? '' : 's'}`,
        subtle: 'Agent folders, allowed folders, the shared folder, a temp folder per run.',
        tone: 'default',
      },
      read: { value: "Nodal's data", subtle: 'Its keys, settings and database.', tone: 'default' },
      network: portsKnown
        ? {
            value: 'Web only',
            subtle: "Internet and local services, over HTTP and HTTPS. Nodal's ports refused:",
            tone: 'default',
          }
        : {
            value: 'Web only',
            subtle:
              "Internet and local services, over HTTP and HTTPS. Nodal's ports are unknown, so none is refused.",
            tone: 'warn',
          },
    };
  }
  // Coupé, l'utilisateur l'a voulu : les valeurs alertent. Indisponible, la
  // machine ne le permet pas : les mêmes valeurs, en neutre.
  const tone = regime === 'off' ? 'warn' : 'default';
  return {
    write: {
      value: 'Anywhere',
      subtle:
        regime === 'off'
          ? `Everything your ${osName(state.platform)} account can write.`
          : 'Everything your account can write.',
      tone,
    },
    read: {
      value: 'Nothing',
      subtle:
        regime === 'off'
          ? "Nodal's keys, settings and database are readable."
          : "Nodal's data is readable.",
      tone,
    },
    network: { value: 'Everything', subtle: "Nodal's own ports included.", tone },
  };
}

// ─── Les limites ─────────────────────────────────────────────────────────────

/** Ce que le bac à sable n'arrête pas, une phrase par code de limite. */
const LIMIT_WORDS: Record<string, string> = {
  SANDBOX_DATA_DIR_NEW_CHILD:
    "A file added to Nodal's data folder during a run is refused from the next run on. Its name can be seen, not its content.",
  SANDBOX_NETWORK_RAW_TCP_LOCAL:
    'Local services are reached over HTTP and HTTPS only. Other protocols have no route.',
  SANDBOX_NETWORK_SHARED_LOOPBACK:
    'A server one run starts on 127.0.0.1 can be reached by a command of another run.',
};

/**
 * Une limite : son code, sa phrase, et le texte que le backend a joint (une
 * donnée de diagnostic, jamais la phrase affichée). Un code que cette version
 * ne connaît pas le dit, au lieu d'afficher le texte du backend comme une
 * phrase de l'interface.
 */
export function limitWords(limit: string): { code: string; words: string; detail: string } {
  const at = limit.indexOf(':');
  const code = at > 0 ? limit.slice(0, at) : limit;
  const detail = at > 0 ? limit.slice(at + 1).trim() : '';
  return {
    code,
    words: LIMIT_WORDS[code] ?? 'This version of Nodal does not describe this limit yet.',
    detail,
  };
}

export function limitsToggleWords(n: number): string {
  return `${n} known limit${n === 1 ? '' : 's'}`;
}

export const LIMITS_TITLE = 'What the sandbox does not stop';

// ─── Les dossiers permis ─────────────────────────────────────────────────────

export function allowedFoldersLede(regime: SandboxRegime, unsupported: boolean): string {
  if (unsupported) return 'You can set them once the sandbox runs on this system.';
  if (regime === 'off')
    return 'Not applied while the sandbox is off. Kept for when you turn it back on.';
  return 'Every command of this workspace can also write here. Stores Nodal finds appear on their own.';
}

/** Le nom du programme d'un magasin que Nodal trouve. */
const FOUND_IN: Record<Exclude<AllowedFolderSourceKey, 'tool-cache' | 'user'>, string> = {
  comfyui: 'ComfyUI',
  ollama: 'Ollama',
  huggingface: 'Hugging Face',
  docker: 'Docker',
};

/** L'étiquette d'un dossier permis : d'où il vient, ou pourquoi il ne s'applique pas. */
export function folderTag(f: {
  source: AllowedFolderSourceKey;
  state: 'allowed' | 'removed' | 'missing' | 'refused';
}): { label: string; variant: 'neutral' | 'info' | 'ok' | 'warn' } {
  if (f.state === 'missing') return { label: 'Not found, skipped', variant: 'warn' };
  if (f.state === 'refused') return { label: "Inside Nodal's data, refused", variant: 'warn' };
  if (f.source === 'tool-cache') return { label: 'Nodal', variant: 'neutral' };
  if (f.source === 'user') return { label: 'Added by you', variant: 'ok' };
  return {
    label: `Found · ${FOUND_IN[f.source]}`,
    variant: f.state === 'removed' ? 'neutral' : 'info',
  };
}

export const ALWAYS_ON = 'Always on';
export const TOOL_CACHE_NOTE =
  'Without it, npm and pip start from an empty cache on every command.';
export const REMOVED_BY_YOU = 'Removed by you';

/** L'alerte d'un ajout refusé parce qu'il est dans les données de Nodal. */
export function nodalDataRefusalWords(path: string, within: string, platform: string): string {
  const same = platform === 'win32' ? path.toLowerCase() === within.toLowerCase() : path === within;
  return same
    ? `${path} is Nodal's data folder. Commands can never write there.`
    : `${path} is inside Nodal's data folder. Commands can never write there.`;
}

/**
 * Le nom d'un dossier et son dossier parent, pour une ligne : `D:\Dev\Nodal`
 * donne `Nodal` et `D:\Dev\`. Une racine de volume (`C:\`, `/`) est son propre
 * nom, sans parent. Les deux séparateurs sont lus : le chemin vient du runner,
 * quel que soit son système.
 */
export function splitFolder(path: string): { name: string; parent: string } {
  const trimmed = path.replace(/[\\/]+$/, '');
  const at = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (trimmed === '' || at < 0 || at === trimmed.length - 1) return { name: path, parent: '' };
  const name = trimmed.slice(at + 1);
  const parent = trimmed.slice(0, at + 1);
  return { name, parent };
}

// ─── Les dossiers des agents ─────────────────────────────────────────────────

export const AGENT_FOLDERS_LEDE =
  "Each agent writes in its own folders. You set them on the agent's page.";
export const EVERY_AGENT = 'Every agent';
export const ALSO_WRITABLE =
  'Also writable during a run: the folder attached to the request, and a temp folder of its own.';

export function withoutFolderWords(names: readonly string[]): string {
  return names.length === 1
    ? `No folder of its own, so it writes only in shared: ${names[0]}.`
    : `No folder of their own, so they write only in shared: ${names.join(', ')}.`;
}

/** Le nom du runtime d'un agent, tel qu'on le dit. */
export function runtimeWords(runtime: string): string {
  return isCliRuntimeValue(runtime) ? CLI_RUNTIME_LABELS[runtime] : runtime;
}

/**
 * La phrase d'un agent dont les commandes ne passent pas par ce bac à sable,
 * d'après le fait que le runner rapporte (`commands`) ; `null` pour un agent
 * confiné.
 */
export function outsideSandboxWords(
  agent: Pick<SandboxAgent, 'name' | 'runtime' | 'commands'>,
): string | null {
  if (agent.commands === 'sandbox') return null;
  if (agent.commands === 'outside') {
    return `${agent.name} runs on ${runtimeWords(agent.runtime)}. Its commands run outside Nodal's sandbox.`;
  }
  return `${agent.name} runs on ${agent.runtime}, which this version does not know. Its commands are not confined by Nodal.`;
}

// ─── Les confirmations ───────────────────────────────────────────────────────

export const TURN_OFF_WORDS = {
  title: 'Turn off the sandbox?',
  message:
    "Commands of every agent in this workspace will run without confinement. They can write anywhere you can and read Nodal's data.",
  confirm: 'Turn off',
} as const;

/** La confirmation d'un dossier qui ouvre presque tout, avec sa conséquence. */
export function broadFolderWords(
  broad: 'volume-root' | 'home',
  path: string,
  platform: string,
): { title: string; message: string; confirm: string } {
  if (broad === 'volume-root') {
    return {
      title: `Allow all of ${path} ?`,
      message: `Commands of every agent in this workspace could write anywhere on this drive, ${osName(platform)} and your programs included.`,
      confirm: `Allow ${path}`,
    };
  }
  return {
    title: 'Allow your whole home folder?',
    message: `Commands of every agent in this workspace could write anywhere in ${path}, your documents included.`,
    confirm: 'Allow',
  };
}

// ─── Le bandeau ──────────────────────────────────────────────────────────────

/**
 * Ce que dit le bandeau du tableau de bord, ou `null` quand il n'a rien à
 * dire. Il parle tant que le bac à sable est coupé, indisponible, ou que son
 * état n'a pas pu être lu : se taire quand on ne sait pas laisserait croire
 * que tout est confiné.
 */
export function sandboxBannerWords(state: SandboxState | null): string | null {
  if (state === null) {
    return 'The sandbox state could not be read. Commands may run without confinement.';
  }
  const regime = sandboxRegime(state);
  if (regime === 'active') return null;
  if (regime === 'off') {
    return 'The sandbox is off for this workspace. Commands run without confinement.';
  }
  if (state.status.state === 'unavailable' && notOnThisSystem(state)) {
    return 'The sandbox is not available on this system yet. Commands run without confinement.';
  }
  const code = state.status.state === 'unavailable' ? state.status.code : '';
  return `The sandbox is unavailable: ${unavailableWords(code).toLowerCase()}. Commands run without confinement.`;
}

/** Où mène le lien « Sandbox » : la section, en tête de Safety. */
export const SANDBOX_SETTINGS_HREF = '/settings?page=safety#sandbox';
