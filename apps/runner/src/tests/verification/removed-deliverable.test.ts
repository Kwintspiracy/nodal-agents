// removed-deliverable.test.ts — un livrable que le job a RETIRÉ n'est pas un
// livrable qui doit exister, tant qu'aucun travail du job n'est perdu
// (issue #916, revue A de la PR #919).
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
//   1. un fichier REÇU (écrit par la plateforme au tour 0) déplacé par
//      `file_move` : la source n'a aucun rouge, son constat est
//      `absent:removed-by-this-run`, vert, et la ligne porte `removed` ; la
//      destination a ses trois constats verts ;
//   2. un fichier que le job a ÉCRIT, puis effacé par un `run_command` de
//      nettoyage : son travail est perdu, donc `exists`, rouge, et la
//      réparation s'ouvre — comme sur main (revue A de #919, passe 1) ;
//   3. un fichier que le job a écrit puis déplacé par `file_move` : la source
//      est verte par son absence, la destination verte ;
//   4. le même déplacement par `run_command` (un déplacement de shell, constaté
//      par l'instantané de checkpoint) : même chose ;
//   5. un fichier qui existait avant le job, qu'il n'a jamais écrit, effacé
//      par `run_command` : aucun rouge ;
//   6. un fichier reçu déplacé, puis sa destination effacée : la source (que
//      le job n'a pas écrite, la plateforme l'a fait) est verte par son
//      absence, la destination rouge — son contenu n'est plus nulle part ;
//   7. un fichier écrit par le job puis effacé HORS de ses appels reste rouge,
//      `exists` « not found » — la différence est l'observation autour de
//      l'appel, jamais une supposition ;
//   8. un fichier retiré par le job qui REVIENT hors de ses appels rougit sur
//      le constat d'absence ;
//   9. un fichier que le job retire puis réécrit redevient un livrable qui doit
//      exister : `removed` levé, `exists` vert ;
//  10. un fichier retiré que l'agent a PROMIS (`declared`) se prouve comme une
//      promesse : `exists`, rouge ;
//  11. un job aux sorties lourdes qui range un brouillon : la source est verte,
//      et aucune sortie qui n'est pas un candidat n'est ouverte — une sortie
//      rendue illisible ne change rien et ne fait rien journaliser (revue A de
//      #919, passe 2 : plus de balayage de tous les chemins constatés) ;
//  12. le contenu perdu posé, HORS du job, à un chemin que le job a écrit avec
//      un AUTRE contenu : ce chemin n'est pas un candidat, le retrait reste
//      rouge — le sauvetage ne vient que des faits rangés ;
//  13. une copie que le job a écrite (empreinte rangée), puis l'original
//      effacé : l'original est vert par son absence.
//
// Mutations vérifiées : la liste est dans la PR #919, avec les tests que
// chacune fait rougir.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
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
import {
  createToolRegistry,
  executeTool,
  recordPlatformWrites,
  registerBuiltins,
} from '@nodal-agents/tools';
import type { ApprovalRule, ExecuteOptions, ToolContext } from '@nodal-agents/tools';
import { finalizeJobSuccess } from '../../job/finalize.ts';
import { REMOVED_PROOF_COMMAND } from '../../verification/removed.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let root: string;
let ws: string;
let jobId: string;
/** Le tour du runner : un par appel, comme une boucle de travail. */
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
  // Une réparation est possible : le test 2 prouve qu'elle s'ouvre.
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
    // Le magasin d'instantanés, comme en production : c'est lui qui constate
    // ce qu'un shell écrit hors de tout dépôt git (#590).
    checkpointsRoot: join(root, 'checkpoints'),
    turn,
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
  turn += 1;
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

/** Une commande Node, portable : les guillemets doubles valent pour cmd.exe comme pour /bin/sh. */
async function shell(script: string): Promise<void> {
  await call('run_command', { purpose: 'test', command: `node -e "${script}"` });
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

function sha(octets: Buffer): string {
  return createHash('sha256').update(octets).digest('hex');
}

/** Tous les rouges du job, toutes lignes confondues. */
async function rouges() {
  const runs = await db.select().from(verificationRuns).where(eq(verificationRuns.jobId, jobId));
  return runs.filter((r) => r.verdict !== 'green').map((r) => `${r.command}: ${r.stderrTail}`);
}

describe('un livrable retiré par le job (#916) @cap:verifier-un-livrable/moteur', () => {
  it('1. file_move d’un fichier reçu : la source n’a aucun rouge, la destination est verte', async () => {
    const source = join(ws, 'recu', 'image.jpg');
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
    expect(src.state.decisionStatus).toBe('green');
    expect(src.runs).toEqual([
      { command: REMOVED_PROOF_COMMAND, verdict: 'green', stderrTail: '' },
    ]);
    const dst = await constats(join(ws, 'Medical', 'scan.jpg'));
    expect(dst.state.removed).toBe(false);
    expect(dst.state.decisionStatus).toBe('green');
    expect(dst.verdicts).toEqual(['exists:green', 'not-empty:green', 'well-formed:jpeg:green']);
  });

  it('2. un fichier que le job a écrit, effacé par une commande, reste rouge et le run se répare', async () => {
    const fichier = join(ws, 'report.md');
    await call('file_write', { path: 'report.md', content: '# Report\n' });
    // La commande ne NOMME pas le fichier comme cible : elle vise son dossier.
    await shell(`require('fs').rmSync('report.md')`);
    expect(await stat(fichier).catch(() => null), 'la commande n’a rien effacé').toBeNull();

    const out = await finalize('supported');

    // Le travail du job est perdu : la preuve du document, et son rouge.
    const f = await constats(fichier);
    expect(f.state.removed).toBe(true);
    expect(f.state.decisionStatus).toBe('red');
    expect(f.verdicts).toEqual(['exists:red']);
    expect(f.runs[0]!.stderrTail).toContain('not found');
    // Et le run est rouvert pour le réécrire.
    expect(out.kind).toBe('repair_due');
    expect(out.repair?.keys).toContain(f.state.canonicalKey);
  });

  it('3. file_move d’un fichier que le job a écrit : la source est verte par son absence', async () => {
    const source = join(ws, 'draft.md');
    await mkdir(join(ws, 'final'), { recursive: true });
    await call('file_write', { path: 'draft.md', content: '# Draft\n' });
    await call('file_move', { source: 'draft.md', destination: 'final/draft.md' });

    await finalize();

    expect(await rouges()).toEqual([]);
    const src = await constats(source);
    expect(src.state.removed).toBe(true);
    expect(src.verdicts).toEqual([`${REMOVED_PROOF_COMMAND}:green`]);
    const dst = await constats(join(ws, 'final', 'draft.md'));
    expect(dst.state.decisionStatus).toBe('green');
    expect(dst.runs[0]).toMatchObject({ command: 'exists', verdict: 'green' });
  });

  it('4. le même déplacement par une commande : la source est verte par son absence', async () => {
    const source = join(ws, 'draft.md');
    await mkdir(join(ws, 'final'), { recursive: true });
    await call('file_write', { path: 'draft.md', content: '# Draft\n' });
    await shell(`require('fs').renameSync('draft.md','final/draft.md')`);
    expect(await stat(source).catch(() => null), 'la commande n’a rien déplacé').toBeNull();

    await finalize();

    expect(await rouges()).toEqual([]);
    const src = await constats(source);
    expect(src.state.removed).toBe(true);
    expect(src.state.decisionStatus).toBe('green');
    expect(src.verdicts).toEqual([`${REMOVED_PROOF_COMMAND}:green`]);
  });

  it('5. un fichier d’avant le job, jamais écrit par lui, effacé par une commande : aucun rouge', async () => {
    const fichier = join(ws, 'ancien.md');
    await writeFile(fichier, '# Ancien\n');
    await shell(`require('fs').rmSync('ancien.md')`);
    expect(await stat(fichier).catch(() => null)).toBeNull();

    await finalize();

    // La commande vise son dossier : ce fichier n'est le livrable d'aucune
    // ligne d'état, et rien de ce que le job a produit n'est perdu.
    expect(await rouges()).toEqual([]);
  });

  it('6. un fichier reçu déplacé puis effacé : source verte (écrite par la plateforme), destination rouge', async () => {
    const source = join(ws, 'recu.txt');
    const octets = Buffer.from('recu\n');
    await writeFile(source, octets);
    await recordPlatformWrites({ db, jobId, files: [{ path: source, sha256: sha(octets) }] });
    await call('file_move', { source: 'recu.txt', destination: 'classe.txt' });
    await shell(`require('fs').rmSync('classe.txt')`);

    await finalize();

    const src = await constats(source);
    expect(src.state.removed).toBe(true);
    expect(src.verdicts).toEqual([`${REMOVED_PROOF_COMMAND}:green`]);
    const dst = await constats(join(ws, 'classe.txt'));
    expect(dst.state.removed).toBe(true);
    expect(dst.verdicts).toEqual(['exists:red']);
  });

  it('7. un fichier écrit par le job puis effacé HORS de ses appels reste rouge', async () => {
    const fichier = join(ws, 'rapport.md');
    await call('file_write', { path: 'rapport.md', content: '# Rapport\n' });
    // Une personne, un autre processus : aucun appel du job autour.
    await rm(fichier);

    await finalize();

    const f = await constats(fichier);
    expect(f.state.removed).toBe(false);
    expect(f.state.decisionStatus).toBe('red');
    expect(f.verdicts).toEqual(['exists:red']);
    expect(f.runs[0]!.stderrTail).toContain('not found');
  });

  it('8. un fichier retiré par le job qui revient HORS de ses appels rougit sur son absence', async () => {
    const source = join(ws, 'a.md');
    await writeFile(source, 'a');
    await call('file_move', { source: 'a.md', destination: 'b.md' });
    await writeFile(source, 'revenu');

    await finalize();

    const src = await constats(source);
    expect(src.state.removed).toBe(true);
    expect(src.state.decisionStatus).toBe('red');
    expect(src.verdicts).toEqual([`${REMOVED_PROOF_COMMAND}:red`]);
    expect(src.runs[0]!.stderrTail).toContain('exists again');
  });

  it('9. un fichier que le job retire puis réécrit redevient un livrable qui doit exister', async () => {
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

  it('10. un fichier retiré que l’agent a PROMIS se prouve comme une promesse : rouge', async () => {
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
    expect(src.verdicts).toEqual(['exists:red']);
  });

  it('11. sorties lourdes et un brouillon rangé : la source est verte, aucune autre sortie n’est ouverte', async () => {
    const lourd = 'x'.repeat(1000 * 1000);
    const sorties = ['out-1.txt', 'out-2.txt', 'out-3.txt'];
    for (const [n, nom] of sorties.entries()) {
      await call('file_write', { path: nom, content: `${n}${lourd}` });
    }
    await mkdir(join(ws, 'final'), { recursive: true });
    await call('file_write', { path: 'draft.md', content: '# Draft\n' });
    await call('file_move', { source: 'draft.md', destination: 'final/draft.md' });
    // Une sortie qu'on ne PEUT PAS lire (sous Linux et macOS : aucun droit ;
    // sous Windows, `chmod` ne retire pas la lecture et le test 12 porte seul
    // la preuve que les non-candidats ne sont pas lus).
    const illisible = join(ws, 'out-1.txt');
    await chmod(illisible, 0o000);
    const avertissements = vi.spyOn(console, 'warn');
    try {
      await finalize();
    } finally {
      await chmod(illisible, 0o644);
    }
    const lus = avertissements.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('VERIFICATION_RESCUE_UNREADABLE'));
    avertissements.mockRestore();

    const src = await constats(join(ws, 'draft.md'));
    expect(src.state.removed).toBe(true);
    expect(src.verdicts).toEqual([`${REMOVED_PROOF_COMMAND}:green`]);
    expect(lus, 'une sortie qui n’est pas un candidat a été ouverte').toEqual([]);
  });

  it('12. le contenu perdu posé hors du job à un chemin que le job a écrit autrement : rouge', async () => {
    const rapport = join(ws, 'report.md');
    await call('file_write', { path: 'report.md', content: '# Report\n' });
    await call('file_write', { path: 'notes.md', content: '# Notes\n' });
    // Une personne recopie le rapport dans les notes : le job n'a pas écrit ça.
    await writeFile(join(ws, 'notes.md'), '# Report\n');
    await shell(`require('fs').rmSync('report.md')`);

    await finalize();

    const f = await constats(rapport);
    expect(f.state.removed).toBe(true);
    expect(f.verdicts).toEqual(['exists:red']);
  });

  it('13. une copie écrite par le job, puis l’original effacé : l’original est vert par son absence', async () => {
    const original = join(ws, 'report.md');
    await call('file_write', { path: 'report.md', content: '# Report\n' });
    // Le même contenu, rapporté par l'outil : son empreinte rangée le désigne.
    await mkdir(join(ws, 'archive'), { recursive: true });
    await call('file_write', { path: 'archive/report.md', content: '# Report\n' });
    await shell(`require('fs').rmSync('report.md')`);

    await finalize();

    expect(await rouges()).toEqual([]);
    const f = await constats(original);
    expect(f.state.removed).toBe(true);
    expect(f.verdicts).toEqual([`${REMOVED_PROOF_COMMAND}:green`]);
  });
});
