// @nodal-agents/checkpoints — the shadow snapshot store, and where it lives.
//
// Its own package for a reason that only appeared when the code was wired up:
// TWO sides need it and neither can reach the other. The runner TAKES snapshots
// (through packages/tools), the CLI RESTORES them — and `apps/cli` importing
// `apps/runner` is an architecture violation dep-cruiser refuses, correctly.
//
// The alternatives were worse. Putting it in `packages/shared` would drop a
// module that spawns `git` into a package that has never touched
// `child_process` — the same mistake as putting the git probe in
// `packages/orchestration`. Adding all of `packages/tools` to the CLI would
// pull the entire tool surface into a 0.6 MB binary to gain one git wrapper.
//
// Zero dependencies beyond Node built-ins, which is what makes it cheap enough
// for both.

export {
  snapshot,
  listCheckpoints,
  restoreCheckpoint,
  ensureStore,
  headCheckpoint,
  diffFile,
  CHECKPOINT_COVERAGE_NOTE,
  DIFF_MAX_BYTES,
  type Checkpoint,
  type FileDiff,
  type SnapshotOptions,
} from './checkpoints';
export { checkpointsRoot } from './root';
// Pourquoi un instantané a échoué, avec ses chiffres — issue #245. Exporté
// parce que les DEUX points de refus (le seam de packages/tools, le harnais CLI
// du runner) doivent rendre LA MÊME phrase : deux copies auraient divergé au
// premier correctif, et c'est celle de l'écran qui serait restée générique.
export {
  CheckpointError,
  isCheckpointError,
  asCheckpointError,
  measureWorkspace,
  describeCheckpointFailure,
  checkpointRefusalMessage,
  checkpointFailureLogLine,
  formatBytes,
  formatCount,
  formatDuration,
  checkpointFailureCode,
  MEASURE_MAX_FILES,
  MEASURE_MAX_MS,
  type CheckpointFailureCause,
  type CheckpointFailureCode,
  type CheckpointFailureFacts,
  type CheckpointOperation,
  type WorkspaceMeasure,
} from './failure';
