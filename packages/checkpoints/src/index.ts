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
  CHECKPOINT_COVERAGE_NOTE,
  type Checkpoint,
} from './checkpoints';
export { checkpointsRoot } from './root';
