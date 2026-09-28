// descendant-files.ts — a file a job's DELEGATE produced in this run (#588).
//
// A root could not use a file its delegate produced. `send_image` refused a
// ComfyArtist output (`source_path_not_allowed`: the file lives in the
// delegate's workspace, not the caller's), and a root that declared that same
// file as its deliverable failed its run (`DECLARED_DELIVERABLES_UNRESOLVED`,
// then `deliverable_not_verified`) although the image existed and was sent.
//
// ONE access rule, for delivery and for declared deliverables alike: a file is
// mine to use when its CURRENT CONTENT is what one of my descendants (children,
// their children…) produced in this run. The path alone proves nothing (review
// of #589, P1): a file deleted and recreated, or replaced at the same path —
// ComfyUI names derive from a prompt hash, reproducible between runs — is not
// what the delegate produced. The proof is the one the platform already uses
// for "was this written by that job" (`currentContentWrittenByJob`,
// record-constat.ts; `filesTheChildWrote`, orchestration/delegated-files.ts):
//
//   - a write the platform fingerprinted (`constated_writes.content_sha256`):
//     the file's current fingerprint must equal the delegate's LAST one at that
//     path — a different one is `changed_since_child_wrote`, refused;
//   - a write nobody could fingerprint (shell, harness: `content_sha256` null,
//     `written_by_child_unverified`), or a file the delegate only DECLARED (an
//     image ComfyUI wrote itself): the file must have been last modified during
//     that delegate's run, between its creation and its end. Another run's
//     output, older, is refused, even declared (review of #589, P2);
//   - and in every case, no job OUTSIDE my descendants may have fingerprinted
//     this exact content at this path: then the content is provably another's.
//
// Paths are compared in ONE space, the real one (`cheminConstate`), on both
// sides: a declared row keeps the LEXICAL path its tool rebased (junctions,
// symlinks — office-file-key.ts), the callers look up the real one (review of
// #589, P2). Descendants are searched in the caller's entity only.

import { stat } from 'node:fs/promises';
import {
  agentJobs,
  and,
  constatedWrites,
  desc,
  eq,
  inArray,
  jobDeliverableVerificationState,
  notInArray,
} from '@nodal-agents/db';
import type { ToolContext } from './types';
import { cheminConstate } from './verification/record-constat';
import { fingerprint } from './verification/observed';

/**
 * How far down the delegation tree to look. Above the product's delegation
 * depth cap (3), so no real chain is cut short; a bound all the same, so a
 * corrupted parent chain cannot loop.
 */
const DESCENDANT_DEPTH_MAX = 8;

interface Descendant {
  id: string;
  /** The window of its run: created by its parent, ended (or still running). */
  from: number;
  to: number;
}

/** Every job below `jobId` in the delegation tree, in `entityId` only. */
async function descendantJobs(
  db: ToolContext['db'],
  entityId: string,
  jobId: string,
): Promise<Descendant[]> {
  const seen = new Set<string>([jobId]);
  let frontier = [jobId];
  const out: Descendant[] = [];
  const now = Date.now();
  for (let depth = 0; depth < DESCENDANT_DEPTH_MAX && frontier.length > 0; depth += 1) {
    const children = await db
      .select({
        id: agentJobs.id,
        createdAt: agentJobs.createdAt,
        completedAt: agentJobs.completedAt,
      })
      .from(agentJobs)
      .where(and(eq(agentJobs.entityId, entityId), inArray(agentJobs.parentJobId, frontier)));
    frontier = [];
    for (const c of children) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({
        id: c.id,
        from: c.createdAt?.getTime() ?? now,
        to: c.completedAt?.getTime() ?? now,
      });
      frontier.push(c.id);
    }
  }
  return out;
}

/** What the rule answers. A read that failed is said as such, never as a "no". */
export type DescendantFileVerdict =
  | { readonly kind: 'produced' }
  | { readonly kind: 'not_produced' }
  | { readonly kind: 'unreadable'; readonly error: string };

/**
 * Is the current content of `absPath` what one of `ctx.jobId`'s descendants
 * produced in this run? See the header for the rule.
 */
export async function fileProducedByDescendant(
  ctx: Pick<ToolContext, 'db' | 'jobId' | 'entityId'>,
  absPath: string,
): Promise<DescendantFileVerdict> {
  if (!ctx.jobId || !ctx.entityId) return { kind: 'not_produced' };
  try {
    const descendants = await descendantJobs(ctx.db, ctx.entityId, ctx.jobId);
    if (descendants.length === 0) return { kind: 'not_produced' };
    const byId = new Map(descendants.map((d) => [d.id, d]));
    const real = await cheminConstate(absPath);

    // Every fingerprint taken at this path, by anyone: the exclusion needs them all.
    const constats = await ctx.db
      .select({ jobId: constatedWrites.jobId, sha: constatedWrites.contentSha256 })
      .from(constatedWrites)
      .where(eq(constatedWrites.path, real))
      .orderBy(desc(constatedWrites.createdAt));

    // What my descendants DECLARED, compared in the real space.
    const t = jobDeliverableVerificationState;
    const declared = await ctx.db
      .select({ jobId: t.jobId, key: t.canonicalKey, path: t.displayPathSnapshot })
      .from(t)
      .where(
        and(
          inArray(
            t.jobId,
            descendants.map((d) => d.id),
          ),
          eq(t.declared, true),
          notInArray(t.deliverableType, ['outbound_action', 'code_project']),
        ),
      );
    const declaredBy = new Set<string>();
    for (const d of declared) {
      if ((await cheminConstate(d.path ?? d.key)) === real) declaredBy.add(d.jobId);
    }

    const current = await fingerprint(real);
    if (current.kind !== 'file') return { kind: 'not_produced' };
    // Another's content, provably: someone outside my descendants fingerprinted it here.
    if (constats.some((c) => !byId.has(c.jobId) && c.sha === current.sha256)) {
      return { kind: 'not_produced' };
    }
    const modifiedAt = (await stat(real)).mtimeMs;

    for (const d of descendants) {
      const last = constats.find((c) => c.jobId === d.id);
      if (last?.sha != null) {
        // A fingerprinted write decides alone: same content, or changed since.
        if (last.sha === current.sha256) return { kind: 'produced' };
        continue;
      }
      const touched = last !== undefined || declaredBy.has(d.id);
      if (touched && modifiedAt >= d.from && modifiedAt <= d.to) return { kind: 'produced' };
    }
    return { kind: 'not_produced' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[delivery] DESCENDANT_FILES_READ_FAILED job=${ctx.jobId} error=${error}`);
    return { kind: 'unreadable', error };
  }
}

/** The error a caller raises when the rule could not be read: never a plain "not yours". */
export function descendantFilesUnreadableMessage(error: string): string {
  return (
    `descendant_files_unreadable: whether a delegate of this job produced this file could not ` +
    `be checked (${error}). It is not a refusal of the file itself: retry, or use a file under ` +
    `your own workspaces.`
  );
}
