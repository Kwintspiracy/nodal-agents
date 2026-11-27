// routes/skills.ts — install / uninstall community skills (open Agent Skills
// format). Synchronous: the dashboard awaits the result (parsed name +
// detected scripts) to show the post-install warning.
//
// Auth: WORKER_SECRET bearer token (web → runner cross-process call).

import type { Context } from 'hono';
import { z } from 'zod';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { isValidWorkerSecret } from '../lib/worker-secret.ts';
import {
  installCommunitySkill,
  uninstallCommunitySkill,
  previewSkillRemoval,
  applySkillUpdate,
  previewSkillUpdate,
  acknowledgeSkillUpdate,
  skillStoreDir,
  SkillInstallError,
  SkillSourceError,
  SkillFetchError,
  FrontmatterError,
} from '../skills/index.ts';

const ConflictChoicesSchema = z.record(
  z.string().min(1).max(1024),
  z.enum(['keep-local', 'take-upstream']),
);

const InstallRequestSchema = z.object({
  source: z.string().min(1).max(2048),
  entityId: z.string().guid(),
  /** Files already in the store for this skill: the review's upstreamFilesHash. */
  expectedFilesHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  conflictChoices: ConflictChoicesSchema.optional(),
});

const UninstallRequestSchema = z.object({
  slug: z.string().min(1).max(128),
  entityId: z.string().guid(),
  /** The person's choice for their own files in the folder (previewSkillRemoval). */
  localFiles: z.enum(['keep', 'delete']).optional(),
});

const UpdateRequestSchema = z.object({
  slug: z.string().min(1).max(128),
  entityId: z.string().guid(),
  /**
   * SKILL-003: hash of the content the owner actually READ in the preview.
   * When present, the apply refuses if upstream moved since. Optional so a
   * caller with no human in the loop can still update.
   */
  expectedContentHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** The preview's upstreamFilesHash: same contract, for the files. */
  expectedFilesHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** One choice per file the preview listed as a conflict, keyed by path. */
  conflictChoices: ConflictChoicesSchema.optional(),
});

const PreviewRequestSchema = z.object({
  slug: z.string().min(1).max(128),
  entityId: z.string().guid(),
});

function checkWorkerSecret(c: Context, runnerEnv: RunnerEnv): Response | null {
  const secret = runnerEnv.WORKER_SECRET;
  if (!secret) return c.json({ error: 'server_misconfiguration' }, 500);
  const auth = c.req.header('Authorization') ?? '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  if (!isValidWorkerSecret(provided, secret)) {
    return c.json({ error: 'invalid_worker_secret' }, 403);
  }
  return null;
}

/** True for errors whose message is a safe, user-facing install diagnostic. */
function isUserFacingInstallError(err: unknown): err is Error {
  return (
    err instanceof SkillInstallError ||
    err instanceof SkillSourceError ||
    err instanceof SkillFetchError ||
    err instanceof FrontmatterError
  );
}

// ─── POST /api/skills/install ───────────────────────────────────────────────

export async function installSkillRoute(
  c: Context,
  deps: RunnerDeps,
  runnerEnv: RunnerEnv,
): Promise<Response> {
  const authFail = checkWorkerSecret(c, runnerEnv);
  if (authFail) return authFail;

  const body = await c.req.json().catch(() => null);
  const parsed = InstallRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  try {
    const result = await installCommunitySkill({
      db: deps.db,
      source: parsed.data.source,
      skillStoreDir: skillStoreDir(parsed.data.entityId),
      entityId: parsed.data.entityId,
      ...(parsed.data.expectedFilesHash === undefined
        ? {}
        : { expectedFilesHash: parsed.data.expectedFilesHash }),
      ...(parsed.data.conflictChoices === undefined
        ? {}
        : { conflictChoices: parsed.data.conflictChoices }),
    });
    return c.json({ ok: true, skill: result }, 200);
  } catch (err) {
    if (isUserFacingInstallError(err)) {
      return c.json({ ok: false, error: 'install_failed', message: err.message }, 400);
    }
    throw err;
  }
}

// ─── POST /api/skills/uninstall ─────────────────────────────────────────────

export async function uninstallSkillRoute(
  c: Context,
  deps: RunnerDeps,
  runnerEnv: RunnerEnv,
): Promise<Response> {
  const authFail = checkWorkerSecret(c, runnerEnv);
  if (authFail) return authFail;

  const body = await c.req.json().catch(() => null);
  const parsed = UninstallRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  try {
    const result = await uninstallCommunitySkill({
      db: deps.db,
      slug: parsed.data.slug,
      skillStoreDir: skillStoreDir(parsed.data.entityId),
      entityId: parsed.data.entityId,
      ...(parsed.data.localFiles === undefined ? {} : { localFiles: parsed.data.localFiles }),
    });
    return c.json({ ok: true, ...result }, 200);
  } catch (err) {
    if (isUserFacingInstallError(err)) {
      return c.json({ ok: false, error: 'uninstall_failed', message: err.message }, 400);
    }
    throw err;
  }
}

// ─── POST /api/skills/preview-uninstall ─────────────────────────────────────
//
// Read-only: the person's files in the skill folder (files the source did not
// ship, shipped files changed here), shown before a removal so the person
// chooses whether they are kept or deleted with the skill.

export async function previewUninstallSkillRoute(
  c: Context,
  deps: RunnerDeps,
  runnerEnv: RunnerEnv,
): Promise<Response> {
  const authFail = checkWorkerSecret(c, runnerEnv);
  if (authFail) return authFail;

  const body = await c.req.json().catch(() => null);
  const parsed = PreviewRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  try {
    const result = await previewSkillRemoval({
      db: deps.db,
      slug: parsed.data.slug,
      skillStoreDir: skillStoreDir(parsed.data.entityId),
      entityId: parsed.data.entityId,
    });
    return c.json({ ok: true, ...result }, 200);
  } catch (err) {
    if (isUserFacingInstallError(err)) {
      return c.json({ ok: false, error: 'preview_failed', message: err.message }, 400);
    }
    throw err;
  }
}

// ─── POST /api/skills/update ────────────────────────────────────────────────
//
// Applies a pending upstream update to an already-installed community skill:
// re-downloads the source, applies the file plan the preview showed (files
// added locally kept, conflicts per the owner's choices) by building the new
// folder beside the old one and switching it in with the DB row, and updates
// the row (defaultContent always; content only when not owner-overridden). If the
// skill's bundled scripts changed, revokes scripts_authorized on every
// agent×skill assignment for it — see applySkillUpdate (skills/install.ts)
// for the full security rationale.

export async function updateSkillRoute(
  c: Context,
  deps: RunnerDeps,
  runnerEnv: RunnerEnv,
): Promise<Response> {
  const authFail = checkWorkerSecret(c, runnerEnv);
  if (authFail) return authFail;

  const body = await c.req.json().catch(() => null);
  const parsed = UpdateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  try {
    const result = await applySkillUpdate({
      db: deps.db,
      slug: parsed.data.slug,
      skillStoreDir: skillStoreDir(parsed.data.entityId),
      entityId: parsed.data.entityId,
      ...(parsed.data.expectedContentHash === undefined
        ? {}
        : { expectedContentHash: parsed.data.expectedContentHash }),
      ...(parsed.data.expectedFilesHash === undefined
        ? {}
        : { expectedFilesHash: parsed.data.expectedFilesHash }),
      ...(parsed.data.conflictChoices === undefined
        ? {}
        : { conflictChoices: parsed.data.conflictChoices }),
    });
    return c.json({ ok: true, ...result }, 200);
  } catch (err) {
    if (isUserFacingInstallError(err)) {
      return c.json({ ok: false, error: 'update_failed', message: err.message }, 400);
    }
    throw err;
  }
}

// ─── POST /api/skills/preview-update ───────────────────────────────────────
//
// SKILL-003: return the ACTUAL text an update would install, so the owner can
// read the diff before approving. The old confirmation showed a category
// ("content changes") for text that goes straight into every assigned agent's
// system prompt — consent without disclosure. Read-only: downloads and
// compares, writes nothing.

export async function previewSkillUpdateRoute(
  c: Context,
  deps: RunnerDeps,
  runnerEnv: RunnerEnv,
): Promise<Response> {
  const authFail = checkWorkerSecret(c, runnerEnv);
  if (authFail) return authFail;

  const body = await c.req.json().catch(() => null);
  const parsed = PreviewRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  try {
    const result = await previewSkillUpdate({
      db: deps.db,
      slug: parsed.data.slug,
      skillStoreDir: skillStoreDir(parsed.data.entityId),
      entityId: parsed.data.entityId,
    });
    return c.json({ ok: true, ...result }, 200);
  } catch (err) {
    if (isUserFacingInstallError(err)) {
      return c.json({ ok: false, error: 'preview_failed', message: err.message }, 400);
    }
    throw err;
  }
}

// ─── POST /api/skills/acknowledge-update ────────────────────────────────────
//
// « Keep my version » for a script conflict: re-baselines the ORIGIN hashes to
// upstream-as-of-now WITHOUT touching local files (no revocation — the owner
// keeps the exact files they vetted). The update badge clears for scripts and
// only returns if upstream moves again. See acknowledgeSkillUpdate
// (skills/install.ts).

export async function acknowledgeSkillUpdateRoute(
  c: Context,
  deps: RunnerDeps,
  runnerEnv: RunnerEnv,
): Promise<Response> {
  const authFail = checkWorkerSecret(c, runnerEnv);
  if (authFail) return authFail;

  const body = await c.req.json().catch(() => null);
  const parsed = UpdateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  try {
    const result = await acknowledgeSkillUpdate({
      db: deps.db,
      slug: parsed.data.slug,
      entityId: parsed.data.entityId,
    });
    return c.json({ ok: true, ...result }, 200);
  } catch (err) {
    if (isUserFacingInstallError(err)) {
      return c.json({ ok: false, error: 'acknowledge_failed', message: err.message }, 400);
    }
    throw err;
  }
}
