// @nodal-agents/sandbox — confiner les ÉCRITURES des commandes d'un agent (#628).
//
// Un paquet à lui, et pas un module de `@nodal-agents/tools`, pour deux
// raisons de couches :
//   - il porte une dépendance native lourde (MXC sous Windows, demain le
//     petit programme Landlock sous Linux) que seul ce paquet charge, et
//     seulement sous l'OS qui la sert ;
//   - le runner doit lire le STATUT (le bandeau D2) et fermer le périmètre
//     d'un job à sa fin, sans tirer tout le catalogue d'outils. `tools` (le
//     moteur shell) et `runner` l'importent ; lui n'importe aucun paquet du
//     dépôt (dependency-cruiser : aucun cycle possible).
//
// Un seul mécanisme pour les trois appelants de l'étape 1 — `run_command`,
// `run_skill_script` et les commandes de preuve — : le moteur shell
// (`runShellCommand`) reçoit la politique et le périmètre du job de
// l'appelant, et passe ici. Le périmètre du job (job-scope.ts) porte aussi ce
// que le job lance hors bac à sable (`code_task`, le CLI d'un runtime) : tout
// meurt à la fin du job (#750, #755).

export {
  type AllowedFolder,
  type AllowedFolderEntry,
  type AllowedFolderSource,
  type AllowedFolderState,
  type ConfinementPolicy,
  type MachineView,
  type PolicyLog,
  type WorkspaceSandboxReader,
  TOOL_CACHE_VARIABLES,
  allowedFolderRefusal,
  broadFolderKind,
  composeAllowedFolders,
  folderKey,
  defaultAllowedFolders,
  noWorkspaceSandbox,
  nodalDataFolders,
  resolveWritableRoots,
  sandboxDeniedPaths,
  nodalDeniedEndpoints,
  NodalHomeReachError,
  NodalPortsUnknown,
  toolCacheEnv,
  toolCacheRoot,
} from './policy';
export {
  SANDBOX_DISABLED,
  type SandboxUnconfinedCode,
  type CommandLaunch,
  type JobContainer,
  type LaunchTarget,
  type ProcessEnd,
  type SandboxBackend,
  type SandboxStatus,
  type SandboxUnavailableCode,
  type StartedProcess,
  SandboxStartError,
} from './types';
export { type Sandbox, createSandbox, defaultSandbox, getSandboxStatus } from './status';
export {
  JobProcessScope,
  type OwnedProcessOptions,
  closeAllJobProcessScopes,
  closeJobProcessScope,
  jobProcessScope,
  killLeftoversOfJob,
  openJobProcessScopeIds,
  openProcessScope,
} from './job-scope';
export {
  JOB_PROCESS_KILL_FAILED,
  isProcessAlive,
  killProcessTree,
  type KillLog,
  type KillTreeOptions,
} from './process-tree';
export { JOB_SCOPE_ENV, detachedDescendantsReachable, pidsTaggedWith } from './unix-job-processes';
export { JobObjectError, openKillOnCloseJob, type KillOnCloseJob } from './windows-job-object';
export { type HostChannel, openJobObjectContainer } from './host-container';
export { DRAIN_MS, JOB_HOST_SOURCE, ensureJobHostScript, sandboxHostDir } from './job-host';
export {
  quoteWindowsArg,
  windowsCommandLine,
  windowsSpawnParts,
  type WindowsSpawnParts,
} from './command-line';
export { type RefusedWrite, extractRefusedWrites } from './refused-writes';
export { startNodalProxy, localAddresses, type NodalProxy, type DeniedEndpoint } from './proxy';
export {
  BROKER_NODE_VERSION,
  BrokerNodeUnavailable,
  ensureBrokerNode,
  verifyPinnedNodeSync,
  pinnedBrokerNodeSha,
  BROKER_NODE_SHA256,
  brokerNodeDir,
  readCachedSha,
  type BrokerNodeDeps,
} from './broker-node';
export {
  DEFAULT_NETWORK_POLICY,
  type NetworkPolicy,
  MXC_BACKEND_NAME,
  mxcBackend,
} from './windows-mxc';
// Les programmes que Nodal lance lui-même (git) sur un dossier qu'une commande
// confinée peut écrire : dans le bac à sable, sans réseau (#628, audit P1-2).
export {
  openNodalPrograms,
  withNodalPrograms,
  nodalProgramsSandbox,
  hostPrograms,
  _setNodalProgramsSandboxForTests,
  type NodalPrograms,
  type NodalProgramsOptions,
  type ProgramRunner,
  type ProgramRunOptions,
  type ProgramChild,
} from './nodal-programs';
