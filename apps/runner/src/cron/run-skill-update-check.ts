// cron/run-skill-update-check.ts — community skill update-check cron phase.
//
// Throttled per-skill via agent_skills.last_update_check_at: selects
// community skills (isCommunity=true, source not null) whose last check is
// NULL or older than SKILL_UPDATE_CHECK_INTERVAL_HOURS, and checks up to
// SKILL_UPDATE_CHECK_BATCH_SIZE of them per tick — spreading load across
// ticks and staying well under GitHub's 60 req/hr anonymous rate limit.
//
// ORDER BY last_update_check_at ASC NULLS FIRST (M1(c), Opus review): without
// an explicit order, a batch smaller than the due set can keep re-selecting
// the same arbitrary subset tick after tick, letting one broken/slow skill
// permanently crowd out the rest. Oldest-checked-first (NULL = never checked
// = oldest) gives every due skill a fair turn.
//
// Processed SEQUENTIALLY (not fanned out) so that hitting the rate limit on
// one skill can abort the rest of THIS tick's batch immediately — every
// unauthenticated GitHub call in this process shares the same 60/hr bucket,
// so continuing to burn through it on other skills would just produce more
// rate-limit hits for no gain. The remaining due skills stay selectable and
// get picked up on a later tick.
//
// Each skill's check is wrapped in its own try/catch (M1(b), Opus review): an
// unexpected error (anything checkSkillUpdate doesn't already turn into a
// typed outcome — e.g. a bug, or a SkillFetchError shape neither
// rate_limited nor not_found matches) is logged and the skill is stamped
// checked-now so it doesn't dominate every future tick's batch, then the loop
// moves on to the next skill instead of losing the rest of the batch.
//
// Idempotent: checkSkillUpdate's own DB write is a plain column update keyed
// on skill id — re-running the same tick twice (or two overlapping ticks)
// converges on the same state, no double-processing hazard.

import {
  eq,
  and,
  or,
  isNull,
  isNotNull,
  lt,
  sql,
  agentSkills,
  type AnyDrizzleDb,
} from '@nodal-agents/db';
import { checkSkillUpdate } from '../skills/check-updates.ts';
import { skillStoreDir } from '../skills/store-dir.ts';

export interface SkillUpdateCheckTickResult {
  /** Skills whose check completed (columns written) — includes `notFound`. */
  checked: number;
  /** Of `checked`, how many turned up an actual content/script change. */
  updatesFound: number;
  /** Of `checked`, how many had a vanished upstream source (404-shaped). */
  notFound: number;
  /** Skills whose check threw an unexpected error — stamped and skipped. */
  errored: number;
  /** True if a rate limit was hit and the rest of the batch was skipped. */
  rateLimited: boolean;
}

export interface SkillUpdateCheckTickEnv {
  SKILL_UPDATE_CHECK_INTERVAL_HOURS: number;
  SKILL_UPDATE_CHECK_BATCH_SIZE: number;
}

export async function runSkillUpdateCheckTick(
  db: AnyDrizzleDb,
  env: SkillUpdateCheckTickEnv,
): Promise<SkillUpdateCheckTickResult> {
  const cutoff = new Date(Date.now() - env.SKILL_UPDATE_CHECK_INTERVAL_HOURS * 60 * 60 * 1000);

  const due = await db
    .select({
      id: agentSkills.id,
      entityId: agentSkills.entityId,
      slug: agentSkills.slug,
      source: agentSkills.source,
      defaultContent: agentSkills.defaultContent,
      installedScripts: agentSkills.installedScripts,
    })
    .from(agentSkills)
    .where(
      and(
        eq(agentSkills.isCommunity, true),
        isNotNull(agentSkills.source),
        or(isNull(agentSkills.lastUpdateCheckAt), lt(agentSkills.lastUpdateCheckAt, cutoff)),
      ),
    )
    .orderBy(sql`${agentSkills.lastUpdateCheckAt} ASC NULLS FIRST`)
    .limit(env.SKILL_UPDATE_CHECK_BATCH_SIZE);

  let checked = 0;
  let updatesFound = 0;
  let notFound = 0;
  let errored = 0;
  let rateLimited = false;

  for (const row of due) {
    // isNotNull(agentSkills.source) already filtered this at the SQL layer;
    // narrows the type for checkSkillUpdate's required `source: string`.
    if (!row.source) continue;

    let outcome: Awaited<ReturnType<typeof checkSkillUpdate>>;
    try {
      outcome = await checkSkillUpdate({
        db,
        skill: {
          id: row.id,
          slug: row.slug,
          source: row.source,
          defaultContent: row.defaultContent,
          installedScripts: row.installedScripts,
        },
        skillStoreDir: skillStoreDir(row.entityId),
      });
    } catch (err) {
      // M1(b): an unexpected throw (bug, or a SkillFetchError shape that's
      // neither rate-limit nor not-found — e.g. the wrapped network error
      // from fetch.ts's M1(a) fix) must not take down the rest of this
      // tick's batch. Stamp it checked-now so it rotates to the back of the
      // ORDER BY queue instead of parking at the front (never stamped) and
      // starving every other due skill behind it.
      errored += 1;
      console.warn(
        `[skill-update-check] unexpected error checking skill "${row.slug}" (${row.id}) — stamping and continuing:`,
        err,
      );
      await db
        .update(agentSkills)
        .set({ lastUpdateCheckAt: new Date() })
        .where(eq(agentSkills.id, row.id));
      continue;
    }

    if (outcome.kind === 'rate_limited') {
      rateLimited = true;
      console.warn(
        "[skill-update-check] GitHub rate limit hit — stopping the rest of this tick's batch.",
      );
      break;
    }
    if (outcome.kind === 'unparseable') {
      console.warn(
        `[skill-update-check] skill "${row.slug}" (${row.id}) has an unparseable source — skipped.`,
      );
      continue;
    }

    checked += 1;
    if (outcome.kind === 'not_found') {
      notFound += 1;
      console.warn(
        `[skill-update-check] skill "${row.slug}" (${row.id}) source no longer resolves upstream.`,
      );
      continue;
    }
    if (outcome.contentChanged || outcome.scriptsChanged) updatesFound += 1;
  }

  return { checked, updatesFound, notFound, errored, rateLimited };
}
