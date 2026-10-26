/**
 * sandbox-copy.ts — les MOTS de l'écran du bac à sable (#876).
 *
 * Le runner rend des codes et des chemins (GET /api/sandbox, invariant #2) ;
 * c'est ici, et nulle part ailleurs, qu'ils deviennent des phrases. Un code que
 * cette table ne connaît pas s'affiche tel quel, avec ce que le backend a dit :
 * jamais une phrase inventée à sa place.
 *
 * Un module sans directive : la section (client), le bandeau (serveur) et les
 * lignes de Réglages le lisent.
 */

import type { AllowedFolderSourceKey, SandboxState } from '@nodal-agents/shared';

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

/** Les limites nommées que le backend déclare, en clair. */
const LIMIT_WORDS: Record<string, string> = {
  SANDBOX_NETWORK_RAW_TCP_LOCAL:
    'Local services and the internet are reached over HTTP and HTTPS only.',
  SANDBOX_NETWORK_SHARED_LOOPBACK:
    'A server one run starts on 127.0.0.1 can be reached by a command of another run.',
  SANDBOX_DATA_DIR_NEW_CHILD:
    'A file Nodal adds to its data folder during a run is refused from the next run on. Its name, not its content, can be listed.',
};

/** Une limite : son code, et sa phrase (la nôtre, ou celle du backend citée). */
export function limitWords(limit: string): { code: string; words: string } {
  const at = limit.indexOf(':');
  const code = at > 0 ? limit.slice(0, at) : limit;
  const quoted = at > 0 ? limit.slice(at + 1).trim() : '';
  return { code, words: LIMIT_WORDS[code] ?? quoted };
}

export const SOURCE_WORDS: Record<AllowedFolderSourceKey, string> = {
  'tool-cache': 'Tool cache',
  comfyui: 'ComfyUI',
  ollama: 'Ollama',
  huggingface: 'Hugging Face',
  docker: 'Docker',
  user: 'Added by you',
};

export const TOOL_CACHE_NOTE =
  'Stays: without it, npm and pip start from an empty cache on every command.';

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

/** La confirmation d'un dossier qui ouvre presque tout, avec sa conséquence. */
export function broadFolderWords(
  broad: 'drive-root' | 'home',
  path: string,
): { title: string; message: string } {
  return {
    title: broad === 'drive-root' ? `Allow the whole ${path} drive?` : 'Allow your home folder?',
    message: `Commands of this workspace will be able to write anywhere in ${path}. Nodal's own data stays refused.`,
  };
}

/** Où mène le lien « Sandbox » : la section, en tête de Safety. */
export const SANDBOX_SETTINGS_HREF = '/settings?page=safety#sandbox';
