// code-task-wiring.test.ts — le CÂBLAGE de code_task, avec un vrai processus.
//
// Ce fichier existe parce que la même faute m'a été renvoyée SIX fois dans ce
// lot : mes tests valident les pièces (un parseur, un capteur, un découpage) et
// jamais le fil qui les relie. La review a trouvé, deux fois de suite, un défaut
// bloquant qu'aucun de ces tests ne pouvait voir :
//
//   passe 1 — l'argv demandait `--output-format json` quand le parseur live
//             attendait du `stream-json` : zéro ligne, pour tout le monde ;
//   passe 2 — le flux verbeux dépasse le tampon plafonné, qui coupe la FIN, là
//             où vit l'événement de résultat : la session échoue après avoir
//             parfaitement tourné.
//
// Le second ne se voit QUE de bout en bout. Une fausse CLI est donc installée
// sur le PATH et code_task est exécuté pour de vrai.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { codeTaskTool } from '../builtin/code-task';
import type { ToolContext } from '../types';

const isWindows = process.platform === 'win32';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let root: string;
let binDir: string;
let ws: string;
let previousPath: string | undefined;

/**
 * Une fausse `claude` qui imite le flux réel : beaucoup de bruit, PUIS
 * l'événement de résultat en dernier. Le volume dépasse volontairement le
 * plafond de capture (400 000 caractères) — c'est tout l'intérêt.
 */
const FAKE_CLI_SCRIPT = `
// La fausse CLI OBEIT a ses arguments — sinon le test « de bout en bout » ne
// prouve pas le couplage argv <-> format, et une regression remettant
// \`--output-format json\` le laisserait vert (constat de la passe 3).
const args = process.argv.slice(2);
const fmt = args[args.indexOf('--output-format') + 1];
if (fmt !== 'stream-json' || !args.includes('--verbose')) {
  // Ce que produit REELLEMENT le mode agrege : un seul objet, en fin de course.
  process.stdout.write(JSON.stringify({
    type: 'result', result: 'AGREGE', session_id: 'sess_fake', is_error: false,
  }));
  process.exit(0);
}
const noise = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'z'.repeat(400) }] },
});
for (let i = 0; i < 1400; i++) process.stdout.write(noise + '\\n');
process.stdout.write(JSON.stringify({
  type: 'tool_use_placeholder',
}) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'result',
  result: 'REPONSE_FINALE',
  session_id: 'sess_fake',
  is_error: false,
  num_turns: 1,
  total_cost_usd: 0.01,
  usage: { input_tokens: 10, output_tokens: 5 },
}) + '\\n');
`;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);

  root = await mkdtemp(join(tmpdir(), 'nodal-ct-'));
  binDir = join(root, 'bin');
  ws = join(root, 'ws');
  await mkdir(binDir, { recursive: true });
  await mkdir(ws, { recursive: true });

  const scriptPath = join(binDir, 'fake-claude.js');
  await writeFile(scriptPath, FAKE_CLI_SCRIPT, 'utf-8');

  // Le shim doit s'appeler comme la CLI cherchée, dans la forme que
  // resolveCliPath reconnaît sur cette plateforme.
  if (isWindows) {
    await writeFile(
      join(binDir, 'claude.cmd'),
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
      'utf-8',
    );
  } else {
    const shim = join(binDir, 'claude');
    await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, 'utf-8');
    await chmod(shim, 0o755);
  }

  previousPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}${isWindows ? ';' : ':'}${previousPath ?? ''}`;
});

afterAll(async () => {
  if (previousPath !== undefined) process.env['PATH'] = previousPath;
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    /* jetable */
  }
});

function ctx(): ToolContext {
  return {
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId: seed.jobId,
    workspaces: [{ label: 'shared', path: ws }],
    turn: 1,
  } as unknown as ToolContext;
}

describe('code_task de bout en bout, vraie CLI', () => {
  it('rend le résultat même quand le flux dépasse le tampon plafonné', async () => {
    // LE test que les deux passes de review réclamaient. La fausse CLI écrit
    // ~560 000 caractères de bruit avant son résultat : le tampon de runCli en
    // garde 400 000 et jette la fin. Si l'analyse finale lit ce tampon, elle
    // échoue sur « stream ended without a result event » — alors que la session
    // a parfaitement tourné.
    const out = (await codeTaskTool.execute(
      {
        purpose: 'test de câblage',
        provider: 'claude',
        task: 'peu importe',
        mode: 'read',
        fresh: true,
      } as never,
      ctx(),
    )) as { resultText: string; sessionId: string | null; isError: boolean };

    expect(out.resultText, 'le résultat a été perdu avec la fin du flux').toBe('REPONSE_FINALE');
    expect(out.sessionId).toBe('sess_fake');
    expect(out.isError).toBe(false);
  }, 60_000);
});
