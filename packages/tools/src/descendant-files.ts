// descendant-files.ts — the files a job's DELEGATES wrote in this run (#588).
//
// A root could not use a file its delegate produced. `send_image` refused a
// ComfyArtist output (`source_path_not_allowed`: the file lives in the
// delegate's workspace, not the caller's), and a root that declared that same
// file as its deliverable failed its run (`DECLARED_DELIVERABLES_UNRESOLVED`,
// then `deliverable_not_verified`) although the image existed and was sent.
// Every replay paid a second delegation just to copy the file.
//
// ONE access rule, for delivery and for declared deliverables alike: a file
// written by one of MY descendants (children, their children…) is resolvable
// by me. It widens nothing else: another agent's files stay out of reach
// unless a job this one delegated wrote them. "Written" is what the platform
// already records for a delegate, and what the delegation hands back as its
// `files_written` (orchestration/router/delegated-files.ts):
//   - the writes the platform constated in the delegate's job
//     (`constated_writes`, deletions excluded);
//   - the files the delegate produced or declared as deliverables
//     (`job_deliverable_verification_state`, files only).

import {
  agentJobs,
  and,
  constatedWrites,
  inArray,
  jobDeliverableVerificationState,
  ne,
  notInArray,
  or,
  eq,
} from '@nodal-agents/db';
import { projectKey } from '@nodal-agents/shared';
import type { ToolContext } from './types';

/**
 * How far down the delegation tree to look. Above the product's delegation
 * depth cap (3), so no real chain is cut short; a bound all the same, so a
 * corrupted parent chain cannot loop.
 */
const DESCENDANT_DEPTH_MAX = 8;

/** The ids of every job below `jobId` in the delegation tree. */
async function descendantJobIds(db: ToolContext['db'], jobId: string): Promise<string[]> {
  const seen = new Set<string>([jobId]);
  let frontier = [jobId];
  const out: string[] = [];
  for (let depth = 0; depth < DESCENDANT_DEPTH_MAX && frontier.length > 0; depth += 1) {
    const children = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(inArray(agentJobs.parentJobId, frontier));
    frontier = [];
    for (const c of children) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c.id);
      frontier.push(c.id);
    }
  }
  return out;
}

/**
 * The files `jobId`'s descendants wrote in this run, as `projectKey`s
 * (slash-normalized, case-folded on Windows), so a lookup matches however the
 * path is spelled.
 */
export async function filesWrittenByDescendants(
  db: ToolContext['db'],
  jobId: string,
): Promise<Set<string>> {
  const jobs = await descendantJobIds(db, jobId);
  const keys = new Set<string>();
  if (jobs.length === 0) return keys;

  const writes = await db
    .select({ path: constatedWrites.path })
    .from(constatedWrites)
    .where(and(inArray(constatedWrites.jobId, jobs), ne(constatedWrites.changeKind, 'deleted')));
  for (const w of writes) keys.add(projectKey(w.path));

  const t = jobDeliverableVerificationState;
  const deliverables = await db
    .select({ key: t.canonicalKey, path: t.displayPathSnapshot })
    .from(t)
    .where(
      and(
        inArray(t.jobId, jobs),
        notInArray(t.deliverableType, ['outbound_action', 'code_project']),
        or(eq(t.produced, true), eq(t.declared, true)),
      ),
    );
  for (const d of deliverables) keys.add(projectKey(d.path ?? d.key));
  return keys;
}

/**
 * True when `absPath` is a file one of `ctx.jobId`'s descendants wrote. A read
 * that fails says so and answers false: the caller then refuses, as it did
 * before this rule existed, and the log names why (invariant #4).
 */
export async function isFileWrittenByDescendant(
  ctx: Pick<ToolContext, 'db' | 'jobId'>,
  absPath: string,
): Promise<boolean> {
  if (!ctx.jobId) return false;
  try {
    const keys = await filesWrittenByDescendants(ctx.db, ctx.jobId);
    return keys.has(projectKey(absPath));
  } catch (err) {
    console.error(
      `[delivery] DESCENDANT_FILES_READ_FAILED job=${ctx.jobId} ` +
        `error=${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
