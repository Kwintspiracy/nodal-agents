// removed-deliverable.test.ts — un livrable que le job a DÉPLACÉ, et l'avait
// déclaré, n'est pas un livrable qui doit exister (issue #916).
//
// LE DÉFAUT, vu sur la stack du propriétaire : un agent déplace un fichier reçu
// dans un dossier de la personne. Le déplacement réussit, la destination est
// verte, et la preuve du run rougit sur la SOURCE — `exists`, « not found » —
// parce que toute cible de mutation devient une ligne d'état, prouvée comme un
// livrable produit.
//
// LA RÈGLE (forme réduite, PR #919) : un livrable retiré par un appel du job
// est une absence attendue si, et seulement si, l'appel avait DÉCLARÉ son
// déplacement (`MutationTarget.movesTo`) vers une destination qui retrouve une
// ligne d'état du même job. Tout autre retrait garde la règle de main :
// `exists`, rouge, dit « retiré par ce run ».
//
// CE QUE CE FICHIER PROUVE, par les VRAIS outils (`file_move`, `file_write`,
// `run_command` du registre des builtins), le vrai seam (`executeTool`) et la
// vraie finalisation, sur les lignes `verification_runs` et
// `job_deliverable_verification_state` relues en base :
//
//   1. le cas du propriétaire : un fichier REÇU (écrit par la plateforme au
//      tour 0) rangé par `file_move` — source verte « déplacé vers X »,
//      destination verte ;
//   2. un fichier posé par un programme externe, rangé par `file_move` : idem ;
//   3. un brouillon écrit par le job puis déplacé par `file_move` : vert ;
//   4. une chaîne a → b → c par deux `file_move` : a et b verts, c vert ;
//   5. la même chaîne, puis c effacé par un shell : la ligne de c est rouge,
//      donc le run n'est pas vérifié ;
//   6. un `mv` de shell : rouge, comme sur main ;
//   7. une copie par `file_move`, puis la source effacée par un shell : rouge ;
//   8. un fichier écrit par le job puis effacé par `rm` : rouge, et le run se
//      répare ;
//   9. les scénarios P1 des passes 4, 6 et 7 de la revue A : rouges ;
//  10. la correspondance par chemin RÉEL : un dossier de l'agent attaché par un
//      alias (jonction sous Windows, lien symbolique ailleurs) — la cible porte
//      le chemin réel, la ligne d'état le chemin lexical — : vert ;
//  11. un fichier effacé HORS des appels du job : rouge, `exists` « not found » ;
//  12. un fichier déplacé qui revient hors des appels du job : rouge sur le
//      constat d'absence ;
//  13. un fichier déplacé puis réécrit par le job : la preuve du document ;
//  14. un fichier déplacé que l'agent a PROMIS : `exists`, rouge ;
//  15. un déplacement déclaré vers une destination qui ne retrouve aucune
//      ligne « fichier » du job (elle tombe dans un projet de code) : rouge ;
//  16. la source effacée par un autre acteur entre la sonde et le `rename` :
//      l'outil échoue (`ok:false`), rien n'est confirmé, la source est rouge
//      (revue A de #919, passe 8) ;
//  17. un appel qui lève après un déplacement confirmé : rouge — seul un appel
//      qui a rendu son résultat fait d'un retrait un déplacement.
//
// Les mutations vérifiées sont listées dans la PR #919.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile, stat } from 'node:fs/promises';
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
import { normalizePath, REPLACE_SHARED_FILE_SETTING } from '@nodal-agents/shared';
import {
  createToolRegistry,
  executeTool,
  recordPlatformWrites,
  registerBuiltins,
} from '@nodal-agents/tools';
import type { ApprovalRule, ExecuteOptions, ToolContext } from '@nodal-agents/tools';
import { finalizeJobSuccess } from '../../job/finalize.ts';
import { MOVED_PROOF_COMMAND, REMOVED_PROOF_COMMAND } from '../../verification/removed.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let root: string;
let ws: string;
let jobId: string;
/** Le tour du runner : un par message du modèle, partagé par ses appels. */
let turn: number;

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
  // Les commandes de ce fichier effacent ou déplacent un fichier, rien de
  // plus : elles tournent hors du bac à sable de l'OS, sans conteneur (#876).
  // Une réparation est possible : le test 8 prouve qu'elle s'ouvre.
  await db
    .update(entities)
    .set({ sandboxEnabled: false, proofRepairAttempts: 1 })
    .where(eq(entities.id, seed.entityId));
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
  turn = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

function ctx(workspace: string = ws): ToolContext {
  return {
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId,
    jobChatId: null,
    // Un dossier de l'agent, pas `shared` : la porte d'écrasement du partagé
    // n'est pas le sujet ici.
    workspaces: [{ label: 'dossier', path: workspace }],
    // Le magasin d'instantanés, comme en production.
    checkpointsRoot: join(root, 'checkpoints'),
    turn,
  } as unknown as ToolContext;
}

// Les lignes que l'agent tient (#917) : une par outil, et le réglage « shared
// file » que file_write et file_move consultent, tous sur Autonomous.
const opts = (): ExecuteOptions => ({
  approvalRules: ['file_write', 'file_move', 'run_command', REPLACE_SHARED_FILE_SETTING].map(
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

/**
 * Un appel d'outil du job. `memeTour` : un autre appel du MÊME message du
 * modèle. `workspace` : le dossier de l'agent, tel qu'il est attaché.
 */
async function call(
  name: string,
  input: Record<string, unknown>,
  o: { memeTour?: boolean; workspace?: string } = {},
): Promise<void> {
  if (!o.memeTour) turn += 1;
  const res = await executeTool(tool(name), input, ctx(o.workspace), opts());
  expect(res.outcome === 'error' ? res.error : res.outcome, `${name} n’a pas abouti`).toBe(
    'success',
  );
  if (res.outcome === 'success') {
    const out = res.output as { ok?: boolean; exitCode?: number | null; stderr?: string };
    expect(out.ok, `${name} a refusé`).not.toBe(false);
    if ('exitCode' in out) expect(out.exitCode, out.stderr).toBe(0);
  }
}

/** Une commande Node, portable : les guillemets doubles valent pour cmd.exe comme pour /bin/sh. */
async function shell(script: string, o: { memeTour?: boolean } = {}): Promise<void> {
  await call('run_command', { purpose: 'test', command: `node -e "${script}"` }, o);
}

async function finalize(repairTurn: 'supported' | 'unsupported' = 'unsupported') {
  return finalizeJobSuccess(
    asDb(),
    { jobId, resultKind: 'prose', repairTurn, result: 'fait' },
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
  return { state, runs, verdicts: runs.map((r) => `${r.command}:${r.verdict}`) };
}

/** Le constat d'un déplacement vers `dest`, tel que la page du run le montre. */
const deplaceVers = (dest: string, verdict: 'green' | 'red' = 'green') =>
  `${MOVED_PROOF_COMMAND} ${normalizePath(dest)}:${verdict}`;

function sha(octets: Buffer): string {
  return createHash('sha256').update(octets).digest('hex');
}

/** Tous les rouges du job, toutes lignes confondues. */
async function rouges() {
  const runs = await db.select().from(verificationRuns).where(eq(verificationRuns.jobId, jobId));
  return runs.filter((r) => r.verdict !== 'green').map((r) => `${r.command}: ${r.stderrTail}`);
}

describe('un livrable déplacé par le job, déclaré (#916) @cap:verifier-un-livrable/moteur', () => {
  it('1. le cas du propriétaire : un fichier reçu rangé par file_move — source et destination vertes', async () => {
    const source = join(ws, 'recu', 'image.jpg');
    const dest = join(ws, 'Medical', 'scan.jpg');
    await mkdir(join(ws, 'recu'), { recursive: true });
    await mkdir(join(ws, 'Medical'), { recursive: true });
    // Un JPEG : l'en-tête que la preuve d'un document vérifie.
    const octets = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    await writeFile(source, octets);
    // L'écriture de l'accueil des fichiers reçus (#918), au tour de la plateforme.
    await recordPlatformWrites({ db, jobId, files: [{ path: source, sha256: sha(octets) }] });

    await call('file_move', { source: 'recu/image.jpg', destination: 'Medical/scan.jpg' });
    expect(await stat(source).catch(() => null), 'le fichier n’a pas quitté sa source').toBeNull();

    await finalize();

    expect(await rouges()).toEqual([]);
    const src = await constats(source);
    expect(src.state.removed).toBe(true);
    expect(src.state.movedToKey).not.toBeNull();
    expect(src.state.decisionStatus).toBe('green');
    expect(src.verdicts).toEqual([deplaceVers(dest)]);
    const dst = await constats(dest);
    expect(dst.state.canonicalKey).toBe(src.state.movedToKey);
    expect(dst.state.removed).toBe(false);
    expect(dst.verdicts).toEqual(['exists:green', 'not-empty:green', 'well-formed:jpeg:green']);
  });

  it('2. un fichier posé par un programme externe, rangé par file_move : vert', async () => {
    const source = join(ws, 'export.txt');
    // Écrit hors de tout appel du job : un autre programme l'a posé là.
    await writeFile(source, 'export');
    await call('file_move', { source: 'export.txt', destination: 'range.txt' });

    await finalize();

    expect(await rouges()).toEqual([]);
    expect((await constats(source)).verdicts).toEqual([deplaceVers(join(ws, 'range.txt'))]);
  });

  it('3. un brouillon écrit par le job puis déplacé par file_move : vert', async () => {
    const source = join(ws, 'draft.md');
    const dest = join(ws, 'final', 'draft.md');
    await mkdir(join(ws, 'final'), { recursive: true });
    await call('file_write', { path: 'draft.md', content: '# Draft\n' });
    await call('file_move', { source: 'draft.md', destination: 'final/draft.md' });

    await finalize();

    expect(await rouges()).toEqual([]);
    expect((await constats(source)).verdicts).toEqual([deplaceVers(dest)]);
    expect((await constats(dest)).runs[0]).toMatchObject({ command: 'exists', verdict: 'green' });
  });

  it('4. une chaîne a → b → c par deux file_move : vert', async () => {
    await call('file_write', { path: 'a.md', content: '# A\n' });
    await call('file_move', { source: 'a.md', destination: 'b.md' });
    await call('file_move', { source: 'b.md', destination: 'c.md' });

    await finalize();

    expect(await rouges()).toEqual([]);
    expect((await constats(join(ws, 'a.md'))).verdicts).toEqual([deplaceVers(join(ws, 'b.md'))]);
    expect((await constats(join(ws, 'b.md'))).verdicts).toEqual([deplaceVers(join(ws, 'c.md'))]);
    expect((await constats(join(ws, 'c.md'))).runs[0]).toMatchObject({
      command: 'exists',
      verdict: 'green',
    });
  });

  it('5. la même chaîne, puis c effacé par un shell : la ligne de c est rouge, le run n’est pas vérifié', async () => {
    await call('file_write', { path: 'a.md', content: '# A\n' });
    await call('file_move', { source: 'a.md', destination: 'b.md' });
    await call('file_move', { source: 'b.md', destination: 'c.md' });
    await shell(`require('fs').rmSync('c.md')`);

    const out = await finalize();

    const c = await constats(join(ws, 'c.md'));
    expect(c.state.removed).toBe(true);
    expect(c.state.decisionStatus).toBe('red');
    expect(c.verdicts).toEqual([`${REMOVED_PROOF_COMMAND}:red`]);
    expect(out.kind).not.toBe('completed');
  });

  it('6. un mv de shell : rouge, comme sur main', async () => {
    const source = join(ws, 'draft.md');
    await mkdir(join(ws, 'final'), { recursive: true });
    await call('file_write', { path: 'draft.md', content: '# Draft\n' });
    await shell(`require('fs').renameSync('draft.md','final/draft.md')`);

    await finalize();

    const r = await constats(source);
    expect(r.state.removed).toBe(true);
    expect(r.state.movedToKey).toBeNull();
    expect(r.verdicts).toEqual([`${REMOVED_PROOF_COMMAND}:red`]);
    expect(r.runs[0]!.stderrTail).toContain('declared no move');
  });

  it('7. une copie par file_move, puis la source effacée par un shell : rouge', async () => {
    await call('file_write', { path: 'a.md', content: 'X' });
    await call('file_move', { source: 'a.md', destination: 'b.md', copy: true });
    await shell(`require('fs').rmSync('a.md')`);

    await finalize();

    expect((await constats(join(ws, 'a.md'))).verdicts).toEqual([`${REMOVED_PROOF_COMMAND}:red`]);
  });

  it('8. un fichier écrit par le job puis effacé par rm : rouge, et le run se répare', async () => {
    const fichier = join(ws, 'report.md');
    await call('file_write', { path: 'report.md', content: '# Report\n' });
    await shell(`require('fs').rmSync('report.md')`);

    const out = await finalize('supported');

    const f = await constats(fichier);
    expect(f.state.removed).toBe(true);
    expect(f.state.decisionStatus).toBe('red');
    expect(f.verdicts).toEqual([`${REMOVED_PROOF_COMMAND}:red`]);
    expect(out.kind).toBe('repair_due');
    expect(out.repair?.keys).toContain(f.state.canonicalKey);
  });

  it('9a. passe 4, P1 : effacer un fichier et en renommer un autre sur l’adresse, puis rm : rouge', async () => {
    await call('file_write', { path: 'report.md', content: 'R0' });
    await call('file_write', { path: 'keep.bin', content: 'K'.repeat(32) });
    await call('file_write', { path: 'keep-copy.bin', content: 'K'.repeat(32) });
    await call('file_write', { path: 'payload.md', content: 'P'.repeat(32) });
    await shell(
      `const f=require('fs');f.unlinkSync('keep.bin');f.renameSync('payload.md','report.md')`,
    );
    await shell(`require('fs').rmSync('report.md')`);

    await finalize();

    expect((await constats(join(ws, 'report.md'))).verdicts).toEqual([
      `${REMOVED_PROOF_COMMAND}:red`,
    ]);
  });

  it('9b. passe 6, P1 : un message efface puis réécrit l’adresse, un tour suivant la retire : rouge', async () => {
    await call('file_write', { path: 'a.md', content: 'A' });
    await shell(`require('fs').rmSync('a.md')`);
    await call('file_write', { path: 'a.md', content: 'B' }, { memeTour: true });
    await shell(`require('fs').rmSync('a.md')`);

    await finalize();

    expect((await constats(join(ws, 'a.md'))).verdicts).toEqual([`${REMOVED_PROOF_COMMAND}:red`]);
  });

  it('9c. passe 7, P1 : écrit, réécrit par un shell hors de tout constat, puis rm : rouge', async () => {
    await call('file_write', { path: 'notes.log', content: 'A' });
    await shell(`require('fs').writeFileSync('notes.log','B')`);
    await shell(`require('fs').rmSync('notes.log')`);

    await finalize();

    expect((await constats(join(ws, 'notes.log'))).verdicts).toEqual([
      `${REMOVED_PROOF_COMMAND}:red`,
    ]);
  });

  it('10. un dossier attaché par un alias : la destination est retrouvée par le chemin réel, vert', async () => {
    // L'alias : une jonction sous Windows (pas de droit d'administrateur), un
    // lien symbolique ailleurs. La cible porte le chemin RÉEL résolu par
    // l'outil, la ligne d'état le chemin lexical de l'alias — la même adresse
    // sous deux orthographes, comme un nom court 8.3 (le rouge de la CI
    // Windows sur 182c2c39).
    const alias = join(root, 'alias');
    await symlink(ws, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await mkdir(join(ws, 'final'), { recursive: true });
    await call('file_write', { path: 'draft.md', content: '# Draft\n' }, { workspace: alias });
    await call(
      'file_move',
      { source: 'draft.md', destination: 'final/draft.md' },
      { workspace: alias },
    );

    await finalize();

    expect(await rouges()).toEqual([]);
    const [src] = await db
      .select()
      .from(jobDeliverableVerificationState)
      .where(
        and(
          eq(jobDeliverableVerificationState.jobId, jobId),
          eq(jobDeliverableVerificationState.removed, true),
        ),
      );
    expect(src?.movedToKey).not.toBeNull();
    expect(src?.decisionStatus).toBe('green');
  });

  it('11. un fichier écrit par le job puis effacé HORS de ses appels reste rouge', async () => {
    const fichier = join(ws, 'rapport.md');
    await call('file_write', { path: 'rapport.md', content: '# Rapport\n' });
    // Une personne, un autre processus : aucun appel du job autour.
    await rm(fichier);

    await finalize();

    const f = await constats(fichier);
    expect(f.state.removed).toBe(false);
    expect(f.verdicts).toEqual(['exists:red']);
    expect(f.runs[0]!.stderrTail).toContain('not found');
  });

  it('12. un fichier déplacé qui revient HORS des appels du job : rouge sur le constat d’absence', async () => {
    const source = join(ws, 'a.md');
    await writeFile(source, 'a');
    await call('file_move', { source: 'a.md', destination: 'b.md' });
    await writeFile(source, 'revenu');

    await finalize();

    const src = await constats(source);
    expect(src.verdicts).toEqual([deplaceVers(join(ws, 'b.md'), 'red')]);
    expect(src.runs[0]!.stderrTail).toContain('exists again');
  });

  it('13. un fichier déplacé puis réécrit par le job : la preuve du document', async () => {
    const source = join(ws, 'note.md');
    await writeFile(source, 'v1');
    await call('file_move', { source: 'note.md', destination: 'archive.md' });
    await call('file_write', { path: 'note.md', content: '# v2\n' });

    await finalize();

    expect(await rouges()).toEqual([]);
    const src = await constats(source);
    expect(src.state.removed).toBe(false);
    expect(src.state.movedToKey).toBeNull();
    expect(src.runs[0]).toMatchObject({ command: 'exists', verdict: 'green' });
  });

  it('14. un fichier déplacé que l’agent a PROMIS se prouve comme une promesse : rouge', async () => {
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

    expect((await constats(source)).verdicts).toEqual(['exists:red']);
  });

  it('15. un déplacement déclaré vers une destination sans ligne « fichier » du job : rouge, comme sur main', async () => {
    // La destination tombe dans un projet de code : son livrable est le
    // PROJET (une autre clé), pas ce fichier. La condition 2 n'est pas réunie.
    const source = join(ws, 'notes.md');
    await mkdir(join(ws, 'app'), { recursive: true });
    await writeFile(join(ws, 'app', 'package.json'), '{"name":"app"}');
    await call('file_write', { path: 'notes.md', content: '# Notes\n' });
    await call('file_move', { source: 'notes.md', destination: 'app/notes.md' });

    await finalize();

    const r = await constats(source);
    expect(r.state.removed).toBe(true);
    expect(r.state.movedToKey).not.toBeNull();
    expect(r.verdicts).toEqual([`${REMOVED_PROOF_COMMAND}:red`]);
  });

  it('16. la source effacée par un autre acteur entre la sonde et le rename : l’outil échoue, la source est rouge', async () => {
    // Le scénario P2 de la revue A, passe 8, à l'identique : la destination est
    // un livrable qui existe déjà, et le `rename` échoue sur ENOENT.
    const x = join(ws, 'x.md');
    await call('file_write', { path: 'x.md', content: '# X\n' });
    await call('file_write', { path: 'report.md', content: '# Report\n' });
    // LA COURSE, au seul point où elle peut tomber : après la sonde d'avant du
    // seam (prise avant `tool.execute`), avant le `rename` de l'outil. Le
    // déplacement lui-même est le vrai `file_move`.
    const vrai = tool('file_move');
    const enCourse = {
      ...vrai,
      execute: async (input: unknown, c: ToolContext) => {
        await rm(x);
        return vrai.execute(input as never, c);
      },
    } as typeof vrai;
    turn += 1;
    const res = await executeTool(
      enCourse,
      { source: 'x.md', destination: 'report.md' },
      ctx(),
      opts(),
    );
    expect(res.outcome).toBe('success');
    expect((res as { output: { ok: boolean } }).output.ok, 'le déplacement n’a pas échoué').toBe(
      false,
    );

    await finalize();

    const r = await constats(x);
    expect(r.state.removed).toBe(true);
    expect(r.state.movedToKey).toBeNull();
    expect(r.verdicts).toEqual([`${REMOVED_PROOF_COMMAND}:red`]);
  });

  it('17. un appel qui lève après un déplacement confirmé : la source est rouge', async () => {
    const a = join(ws, 'a.md');
    await call('file_write', { path: 'a.md', content: '# A\n' });
    // Le vrai `file_move` déplace et confirme, puis l'appel lève : un appel qui
    // n'a pas rendu son résultat ne fait d'aucun retrait un déplacement.
    const vrai = tool('file_move');
    const quiLeve = {
      ...vrai,
      execute: async (input: unknown, c: ToolContext) => {
        await vrai.execute(input as never, c);
        throw new Error('panne après le déplacement');
      },
    } as typeof vrai;
    turn += 1;
    const res = await executeTool(quiLeve, { source: 'a.md', destination: 'b.md' }, ctx(), opts());
    expect(res.outcome).toBe('error');
    expect(await stat(a).catch(() => null), 'le fichier n’a pas été déplacé').toBeNull();

    await finalize();

    const r = await constats(a);
    expect(r.state.removed).toBe(true);
    expect(r.state.movedToKey).toBeNull();
    expect(r.verdicts).toEqual([`${REMOVED_PROOF_COMMAND}:red`]);
  });
});
