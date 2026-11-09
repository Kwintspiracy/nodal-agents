// chat/job-announcement.ts — l'agent ÉCRIT ce qu'il dira quand un job lancé par la voix finit (#967).
//
// Une génération courte, après la fin du job, par le MÊME agent : sa
// personnalité, son modèle, sa chaîne de repli, et son effort « quand on lui
// parle » (#977), puisque l'annonce est entendue. La consigne est
// `buildSpokenAnnouncement` (packages/orchestration) : la demande et le
// résultat, cités tels qu'en base. Ce qui revient est dit TEL QUEL : rien
// n'est coupé, réécrit ni choisi ici (invariant #2).
//
// Pourquoi une génération de plus plutôt qu'une seconde sortie demandée au job
// lui-même : le résultat reste, à l'octet, ce qu'il est aujourd'hui sur toute
// surface ; le chemin est le même pour tout runtime (le job n'a rien à
// apprendre) ; et seul un job lancé par la voix paie l'appel.
//
// Un échec se dit, jamais remplacé par un texte du runner (invariant #4) :
// l'agent sans modèle configuré, le modèle en échec, une annonce vide.

import { agentJobs, agents, eq } from '@nodal-agents/db';
import type { LlmCallObserver } from '@nodal-agents/llm';
import { buildSpokenAnnouncement } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../deps.ts';
import { resolveAgentLlmClient } from '../job/resolve-llm.ts';

export type JobAnnouncement =
  | { ok: true; text: string }
  | { ok: false; code: string; detail?: string };

/**
 * L'annonce du job `jobId`, écrite par son agent. `observe` : le traceur des
 * appels (`llm_calls`) ; `null` pour une mesure qui n'écrit rien en base.
 */
export async function writeJobAnnouncement(
  db: RunnerDeps['db'],
  jobId: string,
  opts: { observe: LlmCallObserver | null },
): Promise<JobAnnouncement> {
  const [row] = await db
    .select({
      task: agentJobs.task,
      result: agentJobs.result,
      entityId: agents.entityId,
      personality: agents.personality,
      model: agents.model,
      llmKeyId: agents.llmKeyId,
      fallbackChain: agents.fallbackChain,
      spokenReasoningEffort: agents.spokenReasoningEffort,
    })
    .from(agentJobs)
    .innerJoin(agents, eq(agents.id, agentJobs.agentId))
    .where(eq(agentJobs.id, jobId))
    .limit(1);
  if (!row) return { ok: false, code: 'announcement_job_not_found' };
  if (!row.model) return { ok: false, code: 'announcement_unavailable', detail: 'agent_no_model' };

  const resolved = await resolveAgentLlmClient(
    db,
    {
      entityId: row.entityId ?? null,
      llmKeyId: row.llmKeyId,
      fallbackChain: row.fallbackChain ?? null,
      model: row.model,
      reasoningEffort: row.spokenReasoningEffort ?? null,
    },
    undefined,
    opts.observe ?? undefined,
  );
  if (!resolved.ok) return { ok: false, code: 'announcement_unavailable', detail: resolved.reason };

  const { system, prompt } = buildSpokenAnnouncement({
    personality: row.personality ?? '',
    request: row.task ?? '',
    result: row.result ?? '',
  });
  let text: string;
  try {
    const out = await resolved.client.generateText({
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    text = (out.text ?? '').trim();
  } catch (err) {
    return {
      ok: false,
      code: 'announcement_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (text === '') return { ok: false, code: 'announcement_empty' };
  return { ok: true, text };
}
