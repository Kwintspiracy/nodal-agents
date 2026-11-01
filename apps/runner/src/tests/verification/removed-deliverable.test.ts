// removed-deliverable.test.ts — un livrable que le job a RETIRÉ n'est pas un
// livrable qui doit exister (issue #916).
//
// LE DÉFAUT, vu sur la stack du propriétaire : un agent déplace un fichier reçu
// dans un dossier de la personne. Le déplacement réussit, la destination est
// verte, et la preuve du run rougit sur la SOURCE — `exists`, « not found » —
// parce que toute cible de mutation devient une ligne d'état, prouvée comme un
// livrable produit.
//
// CE QUE CE FICHIER PROUVE, par les VRAIS outils (`file_move`, `file_write`,
// `run_command` du registre des builtins), le vrai seam (`executeTool`) et la
// vraie finalisation, sur les lignes `verification_runs` et
// `job_deliverable_verification_state` relues en base :
//
//   1. une source déplacée par `file_move` n'a aucun rouge : son constat est
//      `absent:removed-by-this-run`, vert, et la ligne porte `removed` ;
//      la destination a ses trois constats verts ;
//   2. un fichier écrit par le job puis effacé par un `run_command` (que rien
//      n'a nommé : la commande vise son dossier) : même chose ;
//   3. un fichier écrit par le job puis effacé HORS de ses appels reste rouge,
//      `exists` « not found » — la différence est l'observation autour de
//      l'appel, jamais une supposition ;
//   4. un fichier retiré par le job qui REVIENT hors de ses appels rougit sur
//      le constat d'absence ;
//   5. un fichier que le job retire puis réécrit redevient un livrable qui doit
//      exister : `removed` levé, `exists` vert ;
//   6. un fichier retiré que l'agent a PROMIS (`declared`) se prouve comme une
//      promesse : `exists`, rouge.
//
// Mutations vérifiées (chacune fait rougir les tests nommés) :
//   - `recordObservedRemovals` retiré d'`execute.ts` → 1, 2, 4, 6 ;
//   - `probeJobDeliverables` qui ne rend rien → 1, 2, 4, 6 ;
//   - `removedDeliverableVerifier` jamais choisi dans `finalize.ts` → 1, 2, 4 ;
//   - `&& !state.declared` retiré de `finalize.ts` → 6 ;
//   - la levée (`absent -> present`) retirée de `removed.ts` → 5 ;
//   - le constat d'absence vert sur un fichier présent → 4.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  entities,
  jobDeliverableVerificationState,
  verificationRuns,
  and,
  asc,
  eq,
} from '@nodal-agents/db';
import { normalizePath } from '@nodal-agents/shared';
import { createToolRegistry, executeTool, registerBuiltins } from '@nodal-agents/tools';
import type { ApprovalRule, ExecuteOptions, ToolContext } from '@nodal-agents/tools';
import { finalizeJobSuccess } from '../../job/finalize.ts';
import { REMOVED_PROOF_COMMAND } from '../../verification/removed.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let root: string;
let ws: string;
let jobId: string;

const registry = createToolRegistry();
registerBuiltins(registry);
function tool(name: string) {
  const t = registry.get(name);
  if (!t) throw new Error(`builtin introuvable: ${name}`);
  return t;
}

const asDb = (): Parameters<typeof finalizeJobSuccess>[0] =>
  db as unknown as Parameters<typeof finalizeJobSuccess>[0];

beforeAll(async () => {
  const spun = await spinUpTestDb();
  db = spun.db;
  seed = await seedMinimal(db);
  // La commande de ce fichier efface un fichier, rien de plus : elle tourne
  // hors du bac à sable de l'OS, sans conteneur (#876).
  await db.update(entities).set({ sandboxEnabled: false }).where(eq(entities.id, seed.entityId));
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nodal-removed-'));
  ws = join(root, 'dossier');
  await mkdir(ws, { recursive: true });
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'removed deliverable',
      status: 'processing',
    })
    .returning({ id: agentJobs.id });
  if (!job) throw new Error('job insert failed');
  jobId = job.id;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

function ctx(): ToolContext {
  return {
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId,
    jobChatId: null,
    // Un dossier de l'agent, pas `shared` : la porte d'écrasement du partagé
    // n'est pas le sujet ici.
    workspaces: [{ label: 'dossier', path: ws }],
    turn: 1,
  } as unknown as ToolContext;
}

const opts = (): ExecuteOptions => ({
  approvalRules: ['file_write', 'file_move', 'run_command'].map(
    (toolName): ApprovalRule => ({
      id: `rule-${toolName}`,
      toolName,
      action: 'auto_approve',
      agentId: seed.agentId,
      entityId: seed.entityId,
    }),
  ),
  onApprovalRequired: async () => {},
});

async function call(name: string, input: Record<string, unknown>): Promise<void> {
  const res = await executeTool(tool(name), input, ctx(), opts());
  expect(res.outcome === 'error' ? res.error : res.outcome, `${name} n’a pas abouti`).toBe(
    'success',
  );
  if (res.outcome === 'success') {
    const out = res.output as { ok?: boolean; exitCode?: number | null; stderr?: string };
    expect(out.ok, `${name} a refusé`).not.toBe(false);
    if ('exitCode' in out) expect(out.exitCode, out.stderr).toBe(0);
  }
}

async function finalize() {
  return finalizeJobSuccess(
    asDb(),
    { jobId, resultKind: 'prose', repairTurn: 'unsupported', result: 'fait' },
    { log: () => {} },
  );
}

/** Les constats de la preuve, par fichier (le chemin d'affichage, comme la page). */
async function constats(path: string) {
  const [state] = await db
    .select()
    .from(jobDeliverableVerificationState)
    .where(
      and(
        eq(jobDeliverableVerificationState.jobId, jobId),
        eq(jobDeliverableVerificationState.displayPathSnapshot, normalizePath(path)),
      ),
    );
  if (!state) throw new Error(`aucune ligne d’état pour ${path}`);
  const runs = await db
    .select({
      command: verificationRuns.command,
      verdict: verificationRuns.verdict,
      stderrTail: verificationRuns.stderrTail,
    })
    .from(verificationRuns)
    .where(
      and(eq(verificationRuns.jobId, jobId), eq(verificationRuns.canonicalKey, state.canonicalKey)),
    )
    .orderBy(asc(verificationRuns.commandRank));
  return { state, runs };
}

/** Tous les rouges du job, toutes lignes confondues. */
async function rouges() {
  const runs = await db.select().from(verificationRuns).where(eq(verificationRuns.jobId, jobId));
  return runs.filter((r) => r.verdict !== 'green').map((r) => `${r.command}: ${r.stderrTail}`);
}

describe('un livrable retiré par le job (#916) @cap:verifier-un-livrable/moteur', () => {
  it('file_move : la source n’a aucun rouge, la destination est verte, la source est dite retirée', async () => {
    const source = join(ws, 'recu', 'image.jpg');
    await mkdir(join(ws, 'recu'), { recursive: true });
    await mkdir(join(ws, 'Medical'), { recursive: true });
    // Un JPEG : l'en-tête que la preuve d'un document vérifie.
    await writeFile(source, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]));

    await call('file_move', { source: 'recu/image.jpg', destination: 'Medical/scan.jpg' });
    expect(await stat(source).catch(() => null), 'le fichier n’a pas quitté sa source').toBeNull();

    await finalize();

    expect(await rouges()).toEqual([]);
    const src = await constats(source);
    expect(src.state.removed).toBe(true);
    expect(src.state.decisionStatus).toBe('green');
    expect(src.runs).toEqual([
      { command: REMOVED_PROOF_COMMAND, verdict: 'green', stderrTail: '' },
    ]);
    const dst = await constats(join(ws, 'Medical', 'scan.jpg'));
    expect(dst.state.removed).toBe(false);
    expect(dst.state.decisionStatus).toBe('green');
    expect(dst.runs.map((r) => `${r.command}:${r.verdict}`)).toEqual([
      'exists:green',
      'not-empty:green',
      'well-formed:jpeg:green',
    ]);
  });

  it('run_command : un fichier que le job a écrit, puis effacé par une commande, est dit retiré', async () => {
    const fichier = join(ws, 'brouillon.md');
    await call('file_write', { path: 'brouillon.md', content: '# Brouillon\n' });
    // La commande ne NOMME pas le fichier comme cible : elle vise son dossier.
    // Les guillemets doubles valent pour cmd.exe comme pour /bin/sh.
    await call('run_command', {
      purpose: 'effacer le brouillon',
      command: `node -e "require('fs').rmSync('brouillon.md')"`,
    });
    expect(await stat(fichier).catch(() => null), 'la commande n’a rien effacé').toBeNull();

    await finalize();

    expect(await rouges()).toEqual([]);
    const f = await constats(fichier);
    expect(f.state.removed).toBe(true);
    expect(f.state.decisionStatus).toBe('green');
    expect(f.runs.map((r) => `${r.command}:${r.verdict}`)).toEqual([
      `${REMOVED_PROOF_COMMAND}:green`,
    ]);
  });

  it('un fichier écrit par le job puis effacé HORS de ses appels reste rouge', async () => {
    const fichier = join(ws, 'rapport.md');
    await call('file_write', { path: 'rapport.md', content: '# Rapport\n' });
    // Une personne, un autre processus : aucun appel du job autour.
    await rm(fichier);

    await finalize();

    const f = await constats(fichier);
    expect(f.state.removed).toBe(false);
    expect(f.state.decisionStatus).toBe('red');
    expect(f.runs).toHaveLength(1);
    expect(f.runs[0]!.command).toBe('exists');
    expect(f.runs[0]!.verdict).toBe('red');
    expect(f.runs[0]!.stderrTail).toContain('not found');
  });

  it('un fichier retiré par le job qui revient HORS de ses appels rougit sur son absence', async () => {
    const source = join(ws, 'a.md');
    await writeFile(source, 'a');
    await call('file_move', { source: 'a.md', destination: 'b.md' });
    await writeFile(source, 'revenu');

    await finalize();

    const src = await constats(source);
    expect(src.state.removed).toBe(true);
    expect(src.state.decisionStatus).toBe('red');
    expect(src.runs).toHaveLength(1);
    expect(src.runs[0]!.command).toBe(REMOVED_PROOF_COMMAND);
    expect(src.runs[0]!.verdict).toBe('red');
    expect(src.runs[0]!.stderrTail).toContain('exists again');
  });

  it('un fichier que le job retire puis réécrit redevient un livrable qui doit exister', async () => {
    const source = join(ws, 'note.md');
    await writeFile(source, 'v1');
    await call('file_move', { source: 'note.md', destination: 'archive.md' });
    await call('file_write', { path: 'note.md', content: '# v2\n' });

    await finalize();

    expect(await rouges()).toEqual([]);
    const src = await constats(source);
    expect(src.state.removed).toBe(false);
    // La preuve d'un document, pas celle d'une absence.
    expect(src.runs[0]).toMatchObject({ command: 'exists', verdict: 'green' });
    expect(src.runs.map((r) => r.command)).not.toContain(REMOVED_PROOF_COMMAND);
  });

  it('un fichier retiré que l’agent a PROMIS se prouve comme une promesse : rouge', async () => {
    const source = join(ws, 'promis.md');
    await writeFile(source, 'x');
    await call('file_move', { source: 'promis.md', destination: 'ailleurs.md' });
    // La promesse de `return_result.deliverables` : le drapeau que la porte pose.
    await db
      .update(jobDeliverableVerificationState)
      .set({ declared: true })
      .where(
        and(
          eq(jobDeliverableVerificationState.jobId, jobId),
          eq(jobDeliverableVerificationState.displayPathSnapshot, normalizePath(source)),
        ),
      );

    await finalize();

    const src = await constats(source);
    expect(src.state.removed).toBe(true);
    expect(src.state.decisionStatus).toBe('red');
    expect(src.runs.map((r) => `${r.command}:${r.verdict}`)).toEqual(['exists:red']);
  });
});
