// @nodal-agents/bench/studio — ce que Bench Studio lit et lance, sans seconde implémentation.
//
// Bench Studio est un outil LOCAL du propriétaire (`pnpm bench:studio`), jamais
// livré. Ses routes vivent dans apps/web, compilées seulement en mode studio ;
// elles n'appellent que ce module, qui rassemble les modules du banc.

export { launchGate, BENCH_SPACE_SCRIPT, type LaunchGate, type GateTarget } from './launch-gate';
export {
  studioCatalog,
  readFixture,
  studioNeeds,
  studioPlan,
  studioModels,
  studioResults,
  studioTrial,
  readResultLines,
  type StudioCatalog,
  type NeedsView,
  type PlanRequest,
  type PlanView,
  type StudioModel,
} from './data';
export {
  RunManager,
  type RunEvent,
  type RunState,
  type LaunchRequest,
  type SessionRunner,
} from './runs';
export { ACTIVITIES, type Activity } from '../workflows/types';
export {
  createStudioRuntime,
  findDeliverable,
  type StudioRuntime,
  type JobTreeView,
  type TreeJob,
  type DeliverableView,
} from './runtime';
export { stackWebUrl } from '../workflows/stack';
export { FIXTURES_DIR } from '../workflows/fixtures';
export {
  duree,
  nombreJetons,
  dollars,
  AVANT_LA_MATRICE,
  aideDeColonne,
} from '../workflows/results';
