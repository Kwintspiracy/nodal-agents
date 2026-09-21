// Built-in: save_routine_state
//
// L'état d'une routine, écrit là où il se relit à l'identique — pas dans la
// mémoire, qui se lit par recherche floue et qui est ce que l'agent sait de
// l'utilisateur, pas son journal de bord. Le pourquoi complet est dans
// packages/db/src/schema/schedule-state.ts.
//
// Cet outil n'est PAS toujours disponible : le runner ne l'offre qu'aux jobs
// déclenchés par une routine (`agent_jobs.schedule_id`), comme il fait pour
// `run_skill_script`. Un agent qui n'en a pas l'usage ne le voit pas dans son
// prompt.

import { z } from 'zod';
import {
  agentJobs,
  eq,
  writeScheduleState,
  ScheduleStateRefused,
  SCHEDULE_STATE_KEY_MAX,
  SCHEDULE_STATE_VALUE_MAX,
} from '@nodal-agents/db';
import type { ToolDefinition } from '../types';

export const SaveRoutineStateInputSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(SCHEDULE_STATE_KEY_MAX)
    .describe(
      'Short identifier for this piece of state, reused verbatim on every run ' +
        '(e.g. "last_announced_version").',
    ),
  value: z
    .string()
    .max(SCHEDULE_STATE_VALUE_MAX)
    .describe('The value to remember for the next run. Short and factual, not a report.'),
});

export type SaveRoutineStateInput = z.infer<typeof SaveRoutineStateInputSchema>;

/**
 * `saved: false` n'est pas une panne : l'appel a bien tourné, il a refusé
 * d'écrire, et il dit pourquoi pour que le modèle corrige son appel plutôt que
 * de croire son état posé.
 */
export type SaveRoutineStateOutput =
  | { saved: true; key: string }
  | { saved: false; reason: string };

export const saveRoutineStateTool: ToolDefinition<
  typeof SaveRoutineStateInputSchema,
  SaveRoutineStateOutput
> = {
  name: 'save_routine_state',
  label: 'Remember where a routine stopped',
  summary:
    'Store a value for the next run of the same routine, such as the last item handled. It is read back at the start of every run.',
  description:
    "Record this routine's own state for its next run — for example the last version you " +
    'announced, or the id of the last item you processed. The state you save here is shown ' +
    'back to you at the start of every run of this routine, exactly as you wrote it. Use the ' +
    'same `key` every time so the new value replaces the old one. This is how you avoid doing ' +
    'the same thing twice; do NOT use `save_memory` for it — memory is what you know about ' +
    'the user, and it is retrieved by search, so a value stored there may not come back.',
  inputSchema: SaveRoutineStateInputSchema,
  riskLevel: 'write',
  card: 'text',
  execute: async (input, ctx) => {
    // La routine à laquelle ce job appartient — lue sur le job, seule source de
    // vérité. Un job peut être une routine sans que rien d'autre ne le dise.
    const [job] = await ctx.db
      .select({ scheduleId: agentJobs.scheduleId })
      .from(agentJobs)
      .where(eq(agentJobs.id, ctx.jobId))
      .limit(1);
    if (!job?.scheduleId) {
      // Échouer FORT plutôt que d'écrire ailleurs (invariant #4) : sans
      // routine, il n'y a pas d'état de routine à poser.
      return {
        saved: false,
        reason:
          'This job was not started by a routine, so it has no routine state. ' +
          'Nothing was saved.',
      };
    }

    try {
      const entry = await writeScheduleState(ctx.db, job.scheduleId, input.key, input.value);
      return { saved: true, key: entry.key };
    } catch (err) {
      if (err instanceof ScheduleStateRefused) return { saved: false, reason: err.reason };
      throw err;
    }
  },
};
