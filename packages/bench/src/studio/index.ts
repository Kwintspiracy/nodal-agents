// @nodal-agents/bench/studio — ce que Bench Studio lit et lance, sans seconde implémentation.
//
// Bench Studio est un outil LOCAL du propriétaire (`pnpm bench:studio`), jamais
// livré. Ses routes vivent dans apps/web, compilées seulement en mode studio ;
// elles n'appellent que ce module, qui rassemble les modules du banc.

export { launchGate, BENCH_SPACE_SCRIPT, type LaunchGate } from './launch-gate';
export {
  studioCatalog,
  readFixture,
  studioNeeds,
  studioPlan,
  studioResults,
  studioTrial,
  readResultLines,
  type StudioCatalog,
  type NeedsView,
  type PlanRequest,
  type PlanView,
} from './data';
export {
  RunManager,
  type RunEvent,
  type RunState,
  type LaunchRequest,
  type SessionRunner,
} from './runs';
export { ACTIVITIES, type Activity } from '../workflows/types';
