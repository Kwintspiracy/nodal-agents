// routes/skills.ts — install / uninstall community skills (open Agent Skills
// format). Synchronous: the dashboard awaits the result (parsed name +
// detected scripts) to show the post-install warning.
//
// Auth: WORKER_SECRET bearer token (web → runner cross-process call).

import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { z } from 'zod';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import {
  installCommunitySkill,
  uninstallCommunitySkill,
  skillStoreDir,
  SkillInstallError,
  SkillSourceError,
  SkillFetchError,
  FrontmatterError,
} from '../skills/index.ts';

const InstallRequestSchema = z.object({
  source: z.string().min(1).max(2048),
  entityId: z.string().guid(),
});

const UninstallRequestSchema = z.object({
  slug: z.string().min(1).max(128),
});

function checkWorkerSecret(c: Context, runnerEnv: RunnerEnv): Response | null {
  const secret = runnerEnv.WORKER_SECRET;
  if (!secret) return c.json({ error: 'server_misconfiguration' }, 500);
  const auth = c.req.header('Authorization') ?? '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !cryptoTimingSafeEqual(a, b)) {
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
      skillStoreDir: skillStoreDir(),
      entityId: parsed.data.entityId,
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
    await uninstallCommunitySkill({
      db: deps.db,
      slug: parsed.data.slug,
      skillStoreDir: skillStoreDir(),
    });
    return c.json({ ok: true }, 200);
  } catch (err) {
    if (isUserFacingInstallError(err)) {
      return c.json({ ok: false, error: 'uninstall_failed', message: err.message }, 400);
    }
    throw err;
  }
}
