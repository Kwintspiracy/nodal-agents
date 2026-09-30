// catalog/skills/safe-tool-use.ts — system skill, shipped with the product.
//
// Source of truth for the 'content' field. The bootstrap seeder
// (seed-default-skills.ts) upserts this row at boot. Users can override
// per-install via the dashboard; overrides are preserved on subsequent
// boots via the 'content_overridden' flag on the agent_skills row.

import type { SystemSkill } from '../types';

export const safeToolUseSkill: SystemSkill = {
  slug: 'safe-tool-use',
  name: 'Safe tool use',
  description:
    'Read before writing. Fail loud with a clear error rather than silently guessing. Take the fewest steps that finish the task.',
  requiredBuiltins: [],
  kind: 'baseline',
  // Ce texte prescrit des outils de fichiers et de shell : seul un job les a.
  surfaces: ['job'],
  // Ce qui en reste vrai sans aucun outil — même raison que pour
  // « Verify before done » (revue Codex de la dette de la PR #73, constat 1).
  //
  // Régime du 01/10/2026 (lot 2 de la 0.9.5). Retirés,
  // parce que le runner les applique déjà et que les dire doublait le geste :
  //  - « Confirm destructive actions » : la porte d'approbation garde le
  //    destructif (posture `destructive_gate`, tools/src/execute.ts) et pose
  //    la carte ; l'agent qui demandait aussi « Confirmer ? » dans la
  //    conversation faisait confirmer deux fois (root agent, 30/09) ;
  //  - « Anti-loop limits » : chain-counters.ts (DEFAULT_LIMITS : 15 chaînes,
  //    50 appels par tour, profondeur 3) et le détecteur de non-progrès du
  //    runner (execute.ts, Guard 1b) les imposent, invariant #8 ;
  //  - les Anti-patterns, redite des trois règles gardées.
  // Le renfort « Especially you » réservé à une liste de modèles
  // (NEEDS_FIRMER_VERIFY, agent-baseline.ts) devient la dernière ligne, pour
  // tout agent : une règle, pas une branche par fournisseur (règle #11).
  contentOnChat: `## Safe tool use

- Pass what you were given, not what you remember: the user's own words, the exact paths, the real values.
- If a job comes back with a failure, report the failure. Do not retry the same thing unchanged, and do not describe it as done.
- Be decisive: once you know what the user asks for, hand it over as one job instead of re-asking, re-listing or narrating what you are about to do.`,
  content: `## Safe tool use

- Read before you write: \`file_read\` an existing file before \`file_write\`, fetch before you patch or delete; never guess a path, endpoint or identifier.
- Fail loud: when a tool returns an error, report the raw error and the call. Do not retry it unchanged, do not switch to a workaround nobody asked for, and never report success.
- Be decisive: use the tools, scripts and exact paths you were given, and never write your own helper or conversion script for what a skill or tool already does: check first. Act once a check passes instead of re-verifying; take the fewest steps that finish the task.`,
};
