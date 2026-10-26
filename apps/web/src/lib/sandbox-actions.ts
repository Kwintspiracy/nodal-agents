'use server';

// sandbox-actions.ts — Réglages → Safety → Sandbox (#876) : lire l'état du bac
// à sable, couper ou rallumer celui de l'espace, régler ses dossiers permis.
//
// LIRE passe par le runner (GET /api/sandbox) : lui seul sait l'état de la
// sonde, les limites, la détection des dossiers et les ports refusés. La
// réponse est validée par `SandboxStateSchema` ; une réponse d'une autre forme
// est une erreur dite, jamais un écran à moitié rempli (invariant #4).
//
// ÉCRIRE va droit en base, par le repo unique (`@nodal-agents/db`,
// workspace-sandbox.ts), que le runner relit à chaque commande : le geste prend
// effet à la commande suivante, sans redémarrer. Seul le propriétaire de
// l'espace écrit, dans tous les modes d'auth (même garde que le frein
// d'urgence) : un réglage de sécurité qu'un membre pourrait couper n'en est pas
// un.
//
// UN AJOUT EST CONTRÔLÉ par la règle du bac à sable lui-même
// (`allowedFolderRefusal`, @nodal-agents/sandbox policy.ts), jamais recopiée
// ici : le dossier de données de Nodal, ou un dossier sous lui, est refusé avec
// la raison. Une racine de disque ou le dossier personnel demandent une
// confirmation (`broadFolderKind`) ; l'action la redemande si l'écran ne l'a
// pas apportée.

import 'server-only';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireAuth } from '@nodal-agents/auth';
import {
  eq,
  entities,
  readWorkspaceSandbox,
  setWorkspaceSandboxEnabled,
  setWorkspaceSandboxFolders,
} from '@nodal-agents/db';
import { allowedFolderRefusal, broadFolderKind, toolCacheRoot } from '@nodal-agents/sandbox';
import { SandboxStateSchema, type SandboxFolders, type SandboxState } from '@nodal-agents/shared';
import { env } from './env.ts';
import { applyActiveEntity, getAuthProvider, getDb } from './server.ts';

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): ActionResult<never> {
  return { ok: false, code, message };
}

async function getSession() {
  const provider = getAuthProvider();
  let req: Request;
  try {
    const h = await headers();
    req = new Request('http://localhost/', { headers: h });
  } catch {
    req = new Request('http://localhost/');
  }
  const session = await requireAuth(req, provider);
  return applyActiveEntity(session, req);
}

/**
 * Le propriétaire de l'espace, et lui seul. Non exportée : ce module porte
 * `'use server'`, chacun de ses exports est un point d'entrée du navigateur.
 */
async function ownerRefusal(session: {
  userId: string;
  entityId: string;
}): Promise<ActionResult<never> | null> {
  const [row] = await getDb()
    .select({ userId: entities.userId })
    .from(entities)
    .where(eq(entities.id, session.entityId));
  if (!row) return fail('not_found', 'Workspace not found');
  if (row.userId !== session.userId) {
    return fail('forbidden', 'Only the workspace owner can change the sandbox.');
  }
  return null;
}

/** Deux chemins désignent-ils le même dossier ? Casse repliée sous Windows. */
function samePath(a: string, b: string): boolean {
  const ka = resolve(a);
  const kb = resolve(b);
  return process.platform === 'win32' ? ka.toLowerCase() === kb.toLowerCase() : ka === kb;
}

// ─── Lire ────────────────────────────────────────────────────────────────────

export type SandboxView = SandboxState & { isOwner: boolean };

/** Combien de temps la page attend le runner avant de dire qu'elle n'a pas pu lire. */
const RUNNER_READ_TIMEOUT_MS = 5_000;

/**
 * L'état du bac à sable pour l'espace de la session, tel que le runner le dit.
 * Un runner injoignable, une réponse refusée ou d'une autre forme rendent un
 * échec codé : la section et le bandeau disent alors qu'ils n'ont pas pu lire,
 * jamais « actif » par défaut.
 */
export async function getSandboxAction(): Promise<ActionResult<SandboxView>> {
  let session: Awaited<ReturnType<typeof getSession>>;
  try {
    session = await getSession();
  } catch (err) {
    console.error('[getSandboxAction] session', err);
    return fail('auth_error', 'Not signed in');
  }
  if (!env.WORKER_SECRET) {
    console.error('[getSandboxAction] WORKER_SECRET missing');
    return fail('config_error', 'Runner secret not configured');
  }
  let res: Response;
  try {
    res = await fetch(
      `${env.RUNNER_URL}/api/sandbox?entityId=${encodeURIComponent(session.entityId)}`,
      {
        headers: { Authorization: `Bearer ${env.WORKER_SECRET}` },
        signal: AbortSignal.timeout(RUNNER_READ_TIMEOUT_MS),
        cache: 'no-store',
      },
    );
  } catch (err) {
    console.error('[getSandboxAction] fetch failed', err);
    return fail('runner_unreachable', 'The runner did not answer.');
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return fail('runner_contract', `The runner answered ${res.status} without a readable body.`);
  }
  if (!res.ok) {
    const code =
      typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `http_${res.status}`;
    return fail(code, `The runner refused to read the sandbox (${code}).`);
  }
  const parsed = SandboxStateSchema.safeParse(body);
  if (!parsed.success) {
    console.error('[getSandboxAction] unexpected runner answer', parsed.error.issues);
    return fail('runner_contract', 'The runner answered in a form this page does not read.');
  }
  let ownerId: string | undefined;
  try {
    [{ userId: ownerId } = { userId: undefined }] = await getDb()
      .select({ userId: entities.userId })
      .from(entities)
      .where(eq(entities.id, session.entityId));
  } catch (err) {
    console.error('[getSandboxAction] owner', err);
    return fail('db_error', 'Failed to read the workspace owner');
  }
  if (ownerId === undefined) return fail('not_found', 'Workspace not found');
  return ok({ ...parsed.data, isOwner: ownerId === session.userId });
}

// ─── L'interrupteur ──────────────────────────────────────────────────────────

const SetEnabledSchema = z.object({ enabled: z.boolean() }).strict();

/** Coupe ou rallume le bac à sable de l'espace. Effet à la commande suivante. */
export async function setSandboxEnabledAction(raw: unknown): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    const parsed = SetEnabledSchema.safeParse(raw);
    if (!parsed.success) return fail('validation_failed', 'Invalid input');
    const refused = await ownerRefusal(session);
    if (refused) return refused;
    await setWorkspaceSandboxEnabled(getDb(), session.entityId, parsed.data.enabled);
    revalidatePath('/', 'layout');
    return ok(undefined);
  } catch (err) {
    console.error('[setSandboxEnabledAction]', err);
    return fail('db_error', 'Failed to save the sandbox switch');
  }
}

// ─── Les dossiers permis ─────────────────────────────────────────────────────

const PathSchema = z.object({ path: z.string().min(1) }).strict();
const AddSchema = z
  .object({ path: z.string().min(1), confirmedBroad: z.boolean().optional() })
  .strict();

/**
 * Ce que l'ajout a fait, la confirmation qu'il attend, ou le refus de la règle
 * du bac à sable (`SANDBOX_REACH_IS_NODAL_HOME`, avec le dossier de données
 * qui contient le chemin) — un refus que l'écran dit en ligne, pas un échec.
 */
export type AddSandboxFolderResult =
  | { kind: 'added' }
  | { kind: 'restored' }
  | { kind: 'confirm'; broad: 'volume-root' | 'home' }
  | { kind: 'refused'; code: string; within: string };

/** Relit, applique `change`, réécrit. Le réglage illisible fait échouer, nommé. */
async function updateFolders(
  entityId: string,
  change: (current: SandboxFolders) => SandboxFolders,
): Promise<void> {
  const db = getDb();
  const current = await readWorkspaceSandbox(db, entityId);
  await setWorkspaceSandboxFolders(db, entityId, change(current.folders));
}

/**
 * Permet un dossier aux commandes de l'espace. Refusé : un chemin relatif, un
 * dossier absent, le dossier de données de Nodal ou un dossier sous lui (rendu
 * comme `refused`, avec son code). Une racine de volume ou le dossier personnel rendent
 * `confirm` tant que l'écran n'a pas confirmé. Un dossier détecté que
 * l'utilisateur avait retiré est simplement rétabli.
 */
export async function addSandboxFolderAction(
  raw: unknown,
): Promise<ActionResult<AddSandboxFolderResult>> {
  try {
    const session = await getSession();
    const parsed = AddSchema.safeParse(raw);
    if (!parsed.success) return fail('validation_failed', 'Invalid input');
    const refused = await ownerRefusal(session);
    if (refused) return refused;
    const path = parsed.data.path;
    if (!isAbsolute(path)) return fail('not_absolute', 'Pick a full folder path.');
    // Le refus d'abord : un dossier de Nodal se refuse pour ce qu'il est, qu'il
    // existe encore ou non.
    const nodal = allowedFolderRefusal(path);
    if (nodal) return ok({ kind: 'refused', code: nodal.code, within: nodal.within });
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return fail('not_found', `${path} is not a folder on this machine.`);

    const current = await readWorkspaceSandbox(getDb(), session.entityId);
    if (current.folders.removed.some((p) => samePath(p, path))) {
      await updateFolders(session.entityId, (f) => ({
        ...f,
        removed: f.removed.filter((p) => !samePath(p, path)),
      }));
      revalidatePath('/settings');
      return ok({ kind: 'restored' });
    }
    if (current.folders.added.some((p) => samePath(p, path))) {
      return fail('already_allowed', `${path} is already allowed.`);
    }
    const broad = broadFolderKind(path);
    if (broad && parsed.data.confirmedBroad !== true) return ok({ kind: 'confirm', broad });

    await updateFolders(session.entityId, (f) => ({ ...f, added: [...f.added, path] }));
    revalidatePath('/settings');
    return ok({ kind: 'added' });
  } catch (err) {
    console.error('[addSandboxFolderAction]', err);
    return fail('db_error', 'Failed to save the allowed folders');
  }
}

/**
 * Retire un dossier de la liste : un ajout de l'utilisateur est oublié, un
 * dossier détecté est noté RETIRÉ (il le reste si le programme est réinstallé).
 * Le cache d'outils ne se retire pas.
 */
export async function removeSandboxFolderAction(raw: unknown): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    const parsed = PathSchema.safeParse(raw);
    if (!parsed.success) return fail('validation_failed', 'Invalid input');
    const refused = await ownerRefusal(session);
    if (refused) return refused;
    const path = parsed.data.path;
    if (samePath(path, toolCacheRoot())) {
      return fail(
        'tool_cache_required',
        'The tool cache stays: without it, npm and pip start from an empty cache on every command.',
      );
    }
    await updateFolders(session.entityId, (f) =>
      f.added.some((p) => samePath(p, path))
        ? { ...f, added: f.added.filter((p) => !samePath(p, path)) }
        : f.removed.some((p) => samePath(p, path))
          ? f
          : { ...f, removed: [...f.removed, path] },
    );
    revalidatePath('/settings');
    return ok(undefined);
  } catch (err) {
    console.error('[removeSandboxFolderAction]', err);
    return fail('db_error', 'Failed to save the allowed folders');
  }
}

/** Rétablit un dossier détecté que l'utilisateur avait retiré. */
export async function restoreSandboxFolderAction(raw: unknown): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    const parsed = PathSchema.safeParse(raw);
    if (!parsed.success) return fail('validation_failed', 'Invalid input');
    const refused = await ownerRefusal(session);
    if (refused) return refused;
    const path = parsed.data.path;
    await updateFolders(session.entityId, (f) => ({
      ...f,
      removed: f.removed.filter((p) => !samePath(p, path)),
    }));
    revalidatePath('/settings');
    return ok(undefined);
  } catch (err) {
    console.error('[restoreSandboxFolderAction]', err);
    return fail('db_error', 'Failed to save the allowed folders');
  }
}
