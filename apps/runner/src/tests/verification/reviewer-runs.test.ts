// reviewer-runs.test.ts — les vérifications d'un relecteur deviennent des
// preuves du travail relu (issue #59), sur une VRAIE base.
//
// @cap:verifier-un-livrable/moteur
//
// Ce que ces cas prouvent, et pourquoi chacun existe :
//
//  - deux commandes lancées par un relecteur ⇒ DEUX lignes `verification_runs`
//    sous le job RELU, avec leur commande, leur code de sortie et leur verdict.
//    C'est le fait qui manquait le 16/09 : six scénarios Playwright lancés, zéro
//    ligne enregistrée ;
//  - un appel qui n'a PAS tourné (refusé, en attente d'approbation) n'entre
//    pas : une preuve inventée serait pire que l'absence de preuve ;
//  - un second verdict ne double pas la trace ;
//  - la sortie est MASQUÉE par la rédaction existante — une preuve n'est pas un
//    nouveau chemin de fuite pour un jeton.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agents,
  agentJobs,
  entities,
  toolCalls,
  users,
  verificationRuns,
  asc,
  eq,
} from '@nodal-agents/db';
import { REDACTED_TEXT } from '@nodal-agents/shared';
import {
  anchorJobId,
  recordReviewerVerificationRuns,
  reviewerVerificationRecord,
  reviewCanonicalKey,
} from '../../verification/reviewer-runs.ts';

let db: TestDb;

/** Une FAUSSE clé, à la forme que le rédacteur reconnaît. */
const JETON = 'sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz0123456789AA'; // secrets:allow (fixture)

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
});

interface Seed {
  entityId: string;
  parentJobId: string;
  reviewerJobId: string;
  reviewerAgentName: string;
}

/** Un travail relu et le relecteur qui en est le délégué. Aucun agent réel. */
async function seed(): Promise<Seed> {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const [user] = await db
    .insert(users)
    .values({ email: `p13-${suffix}@example.test` })
    .returning();
  const [entity] = await db
    .insert(entities)
    .values({ userId: user!.id, name: 'T', slug: `e-p13-${suffix}` })
    .returning();
  const [builder] = await db
    .insert(agents)
    .values({
      entityId: entity!.id,
      name: 'Builder',
      slug: `builder-${suffix}`,
      personality: 'p',
      role: 'agent',
      active: true,
    })
    .returning();
  const reviewerAgentName = 'Second Pair Of Eyes';
  const [reviewer] = await db
    .insert(agents)
    .values({
      entityId: entity!.id,
      name: reviewerAgentName,
      slug: `second-pair-${suffix}`,
      personality: 'p',
      role: 'agent',
      active: true,
    })
    .returning();
  const [parent] = await db
    .insert(agentJobs)
    .values({
      entityId: entity!.id,
      agentId: builder!.id,
      channel: 'internal',
      task: 'build the little web app',
      status: 'completed',
    })
    .returning();
  const [reviewerJob] = await db
    .insert(agentJobs)
    .values({
      entityId: entity!.id,
      agentId: reviewer!.id,
      channel: 'internal',
      task: 'review the little web app',
      status: 'completed',
      parentJobId: parent!.id,
    })
    .returning();
  return {
    entityId: entity!.id,
    parentJobId: parent!.id,
    reviewerJobId: reviewerJob!.id,
    reviewerAgentName,
  };
}

/**
 * Une ligne `tool_calls` DANS LA FORME DE PRODUCTION : `executeTool`
 * (`packages/tools/src/execute.ts`) écrit `JSON.stringify(output)`, la valeur
 * rendue par l'`execute()` de l'outil. Pour `run_command`, c'est exactement
 * `RunCommandOutput`.
 */
async function recordCommand(
  s: Seed,
  command: string,
  output: Record<string, unknown>,
  durationMs = 1200,
): Promise<void> {
  await db.insert(toolCalls).values({
    entityId: s.entityId,
    jobId: s.reviewerJobId,
    toolName: 'run_command',
    toolInput: { command },
    toolOutput: JSON.stringify(output),
    durationMs,
    turn: 1,
  });
}

function shellOutput(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    truncated: false,
    cwd: 'D:/tmp/app',
    ...over,
  };
}

async function rowsFor(jobId: string) {
  return db
    .select({
      command: verificationRuns.command,
      exitCode: verificationRuns.exitCode,
      outcomeKind: verificationRuns.outcomeKind,
      verdict: verificationRuns.verdict,
      durationMs: verificationRuns.durationMs,
      stdoutTail: verificationRuns.stdoutTail,
      sequenceId: verificationRuns.sequenceId,
      commandRank: verificationRuns.commandRank,
      canonicalKey: verificationRuns.canonicalKey,
      source: verificationRuns.source,
      sourceJobId: verificationRuns.sourceJobId,
    })
    .from(verificationRuns)
    .where(eq(verificationRuns.jobId, jobId))
    .orderBy(asc(verificationRuns.commandRank));
}

describe('recordReviewerVerificationRuns @cap:verifier-un-livrable/moteur', () => {
  it('écrit les deux commandes du relecteur sous le job RELU, avec leur résultat réel', async () => {
    const s = await seed();
    await recordCommand(s, 'npx playwright test tests/e2e/panier.spec.ts', shellOutput());
    await recordCommand(
      s,
      'node --check app.js',
      shellOutput({ exitCode: 1, stderr: 'SyntaxError: Unexpected token' }),
      340,
    );

    const written = await recordReviewerVerificationRuns(db, s.reviewerJobId);
    expect(written).toBe(2);

    // Sous le PARENT, pas sous le relecteur : c'est le travail relu dont la
    // page doit montrer ce que la relecture a éprouvé.
    expect(await rowsFor(s.reviewerJobId)).toHaveLength(0);
    const rows = await rowsFor(s.parentJobId);
    expect(rows.map((r) => r.command)).toEqual([
      'npx playwright test tests/e2e/panier.spec.ts',
      'node --check app.js',
    ]);
    expect(rows.map((r) => r.exitCode)).toEqual([0, 1]);
    // Le VERDICT réel de chaque commande, pas un état global du relecteur.
    expect(rows.map((r) => r.verdict)).toEqual(['green', 'red']);
    expect(rows.map((r) => r.outcomeKind)).toEqual(['exit', 'exit']);
    expect(rows.map((r) => r.durationMs)).toEqual([1200, 340]);
    // Une seule séquence : ces commandes sont UNE relecture.
    expect(new Set(rows.map((r) => r.sequenceId)).size).toBe(1);
    expect(rows.map((r) => r.commandRank)).toEqual([1, 2]);
    expect(rows.map((r) => r.source)).toEqual(['reviewer', 'reviewer']);
    expect(rows.map((r) => r.sourceJobId)).toEqual([s.reviewerJobId, s.reviewerJobId]);
    expect(new Set(rows.map((r) => r.canonicalKey))).toEqual(
      new Set([reviewCanonicalKey(s.reviewerJobId)]),
    );
  });

  it('classe un timeout et une panne de lancement en infra_error, jamais en rouge', async () => {
    const s = await seed();
    await recordCommand(s, 'pnpm test', shellOutput({ exitCode: null, timedOut: true }));
    await recordCommand(
      s,
      'playwright test',
      shellOutput({ exitCode: null, stderr: 'spawn_error: ENOENT' }),
    );

    await recordReviewerVerificationRuns(db, s.reviewerJobId);
    const rows = await rowsFor(s.parentJobId);
    expect(rows.map((r) => r.outcomeKind)).toEqual(['timeout', 'spawn_error']);
    expect(rows.map((r) => r.verdict)).toEqual(['infra_error', 'infra_error']);
  });

  it("n'écrit RIEN pour un appel qui n'a pas tourné", async () => {
    const s = await seed();
    // La forme exacte d'un refus d'outil : une issue, pas un processus.
    await db.insert(toolCalls).values({
      entityId: s.entityId,
      jobId: s.reviewerJobId,
      toolName: 'run_command',
      toolInput: { command: 'rm -rf /' },
      toolOutput: JSON.stringify({ outcome: 'blocked', error: 'command_not_allowed' }),
      turn: 1,
    });
    // Et une lecture de fichier, qui n'est pas une vérification.
    await db.insert(toolCalls).values({
      entityId: s.entityId,
      jobId: s.reviewerJobId,
      toolName: 'file_read',
      toolInput: { path: 'app.js' },
      toolOutput: JSON.stringify({ content: 'const a = 1;' }),
      turn: 1,
    });

    const written = await recordReviewerVerificationRuns(db, s.reviewerJobId);
    expect(written).toBe(0);
    expect(await rowsFor(s.parentJobId)).toHaveLength(0);
  });

  it('masque les secrets de la sortie enregistrée', async () => {
    const s = await seed();
    await recordCommand(s, 'node scripts/check.js', shellOutput({ stdout: `token ${JETON}` }));

    await recordReviewerVerificationRuns(db, s.reviewerJobId);
    const rows = await rowsFor(s.parentJobId);
    expect(rows[0]!.stdoutTail).toContain(REDACTED_TEXT);
    expect(rows[0]!.stdoutTail).not.toContain(JETON);
  });

  it('un second verdict ne double pas la trace — la dernière lecture remplace la première', async () => {
    const s = await seed();
    await recordCommand(s, 'pnpm typecheck', shellOutput());
    await recordReviewerVerificationRuns(db, s.reviewerJobId);
    // Le relecteur relance une commande, puis rappelle `review_verdict`.
    await recordCommand(s, 'pnpm test', shellOutput({ exitCode: 1 }));
    const written = await recordReviewerVerificationRuns(db, s.reviewerJobId);

    expect(written).toBe(2);
    const rows = await rowsFor(s.parentJobId);
    expect(rows.map((r) => r.command)).toEqual(['pnpm typecheck', 'pnpm test']);
    expect(rows).toHaveLength(2);
  });

  it('sans parent, la preuve reste sous le job qui l’a lancée', async () => {
    const s = await seed();
    await db.update(agentJobs).set({ parentJobId: null }).where(eq(agentJobs.id, s.reviewerJobId));
    await recordCommand(s, 'pnpm lint', shellOutput());

    await recordReviewerVerificationRuns(db, s.reviewerJobId);
    expect(await rowsFor(s.reviewerJobId)).toHaveLength(1);
    expect(anchorJobId(s.reviewerJobId, null)).toBe(s.reviewerJobId);
  });
});

describe('reviewerVerificationRecord @cap:verifier-un-livrable/moteur', () => {
  it('lit la commande de run_skill_script avec ses arguments', () => {
    const record = reviewerVerificationRecord({
      toolName: 'run_skill_script',
      toolInput: { skill: 'qa', script: 'scripts/smoke.py', args: ['--url', 'http://localhost'] },
      toolOutput: JSON.stringify({
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        timedOut: false,
        truncated: false,
        interpreter: 'python3',
        script: 'scripts/smoke.py',
      }),
      durationMs: 42,
    });
    expect(record?.command).toBe('scripts/smoke.py --url http://localhost');
    expect(record?.verdict).toBe('green');
  });

  it('rend null sur une sortie qui ne décrit aucun processus', () => {
    for (const toolOutput of [null, 'not json', '{}', JSON.stringify({ exitCode: 0 })]) {
      expect(
        reviewerVerificationRecord({
          toolName: 'run_command',
          toolInput: { command: 'pnpm test' },
          toolOutput,
          durationMs: null,
        }),
      ).toBeNull();
    }
  });
});
