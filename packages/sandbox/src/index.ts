// @nodal-agents/sandbox — confiner les ÉCRITURES des commandes d'un agent (#628).
//
// Un paquet à lui, et pas un module de `@nodal-agents/tools`, pour deux
// raisons de couches :
//   - il porte une dépendance native lourde (MXC sous Windows, demain le
//     petit programme Landlock sous Linux) que seul ce paquet charge, et
//     seulement sous l'OS qui la sert ;
//   - le runner doit lire le STATUT (le bandeau D2) sans tirer tout le
//     catalogue d'outils. `tools` (le moteur shell) et `runner` l'importent ;
//     lui n'importe aucun paquet du dépôt (dependency-cruiser : aucun cycle
//     possible).
//
// Un seul mécanisme pour les trois appelants de l'étape 1 — `run_command`,
// `run_skill_script` et les commandes de preuve — : le moteur shell
// (`runShellCommand`) reçoit la politique de l'appelant et passe ici.

export {
  type ConfinementPolicy,
  TOOL_CACHE_VARIABLES,
  resolveWritableRoots,
  toolCacheEnv,
  toolCacheRoot,
} from './policy';
export {
  type ConfinedLaunch,
  type LaunchTarget,
  type ProcessEnd,
  type SandboxBackend,
  type SandboxStatus,
  type SandboxUnavailableCode,
  type StartedProcess,
  SandboxStartError,
} from './types';
export { type Sandbox, createSandbox, defaultSandbox, getSandboxStatus } from './status';
export { quoteWindowsArg, windowsCommandLine } from './command-line';
export { type RefusedWrite, extractRefusedWrites } from './refused-writes';
export { MXC_BACKEND_NAME, mxcBackend } from './windows-mxc';
