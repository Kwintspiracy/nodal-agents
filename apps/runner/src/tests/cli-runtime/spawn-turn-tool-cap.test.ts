// spawn-turn-tool-cap.test.ts — le budget d'appels par tour sur un runtime CLI
// (invariant #8, revue Codex de #568).
//
// Un runtime CLI (Claude Code, Codex) exécute SES outils dans SON processus :
// le runner ne les voit qu'au fil du flux, et le nombre d'appels d'un tour
// n'est jamais connu d'avance. Ce que la plateforme peut garantir ici n'est
// donc pas le refus du tour entier (#564, boucle Nodal) mais ceci : le
// processus est tué dès la ligne qui OUVRE l'appel au-delà du budget, avant
// que le runner lise quoi que ce soit après elle — en particulier le résultat
// de cet appel.
//
// Preuve sur un VRAI processus : une fausse CLI ouvre N appels, puis, comme
// une CLI qui exécute l'outil qu'elle vient d'annoncer, écrit un fichier
// témoin et imprime le résultat. Au-delà du budget, le témoin ne doit jamais
// exister. Au budget exact, il doit exister : sans ce contrôle, le test
// passerait aussi contre une fausse CLI qui n'écrit rien.
//
// Les deux lecteurs de flux réels (Claude, Codex) sont branchés, pas un
// compteur de test : c'est leur câblage vers le garde qui est prouvé.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnCliTurn } from '../../cli-runtime/spawn-turn.ts';
import { countToolUses, newStreamParseState } from '../../cli-runtime/claude-turn.ts';
import { handleCodexLine, newCodexParseState } from '../../cli-runtime/codex-turn.ts';
import { DEFAULT_LIMITS } from '@nodal-agents/orchestration';

const BUDGET = DEFAULT_LIMITS.maxToolCallsPerTurn;

/** Une ligne d'appel au format stream-json de Claude (un ou plusieurs blocs parallèles). */
function claudeOpenLine(ids: string[]): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: ids.map((id) => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'x' } })),
    },
  });
}
function claudeResultLine(id: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  });
}
/** Ouverture d'un appel au format `codex exec --json`. */
function codexOpenLine(id: string): string {
  return JSON.stringify({
    type: 'item.started',
    item: { id, type: 'command_execution', command: 'x', status: 'in_progress' },
  });
}
function codexResultLine(id: string): string {
  return JSON.stringify({
    type: 'item.completed',
    item: {
      id,
      type: 'command_execution',
      command: 'x',
      aggregated_output: 'ok',
      exit_code: 0,
      status: 'completed',
    },
  });
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nodal-cli-cap-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Lance une fausse CLI : elle imprime `openLines` (les appels annoncés), puis,
 * après un délai, écrit le fichier témoin (l'effet du DERNIER appel annoncé)
 * et imprime `resultLine`. Rend l'issue et toutes les lignes que le runner a lues.
 */
async function runFakeCli(
  openLines: string[],
  resultLine: string,
  onLine: (line: string) => number,
): Promise<{ toolCapExceeded?: number; linesSeen: string[]; effectHappened: boolean }> {
  const marker = join(dir, 'effect-of-last-call');
  const script = join(dir, 'fake-cli.cjs');
  await writeFile(
    script,
    [
      "const fs = require('node:fs');",
      `const opens = ${JSON.stringify(openLines)};`,
      "process.stdout.write(opens.join('\\n') + '\\n');",
      // Le délai rend l'ordre observable : le kill doit tomber AVANT l'effet.
      'setTimeout(() => {',
      `  fs.writeFileSync(${JSON.stringify(marker)}, 'done');`,
      `  process.stdout.write(${JSON.stringify(resultLine)} + '\\n');`,
      '}, 3000);',
    ].join('\n'),
  );
  const linesSeen: string[] = [];
  const outcome = await spawnCliTurn({
    argv: [process.execPath, script],
    env: process.env,
    cwd: dir,
    stdin: '',
    timeoutMs: 60_000,
    maxToolCalls: BUDGET,
    onLine: (line) => {
      linesSeen.push(line);
      return onLine(line);
    },
    finish: (o) => o,
  });
  // Laisser à un processus qui aurait survécu le temps d'écrire son effet.
  await new Promise((r) => setTimeout(r, 3500));
  return {
    ...(outcome.toolCapExceeded !== undefined ? { toolCapExceeded: outcome.toolCapExceeded } : {}),
    linesSeen,
    effectHappened: existsSync(marker),
  };
}

describe('spawnCliTurn — budget d appels par tour d un runtime CLI @cap:suivre-execution/moteur', () => {
  it('Claude : le processus est tué à l ouverture du 51e appel, son effet et son résultat n arrivent jamais', async () => {
    // 45 appels un à un, puis 6 parallèles dans UN événement (45 + 6 = 51).
    const ids = Array.from({ length: BUDGET + 1 }, (_, i) => `toolu_${i}`);
    const opens = [
      ...ids.slice(0, 45).map((id) => claudeOpenLine([id])),
      claudeOpenLine(ids.slice(45)),
    ];
    const state = newStreamParseState();
    const run = await runFakeCli(opens, claudeResultLine(ids[BUDGET]!), (l) =>
      countToolUses(state, l),
    );

    expect(run.toolCapExceeded).toBe(BUDGET);
    expect(run.effectHappened, 'l appel au-delà du budget a produit son effet').toBe(false);
    expect(run.linesSeen.some((l) => l.includes('"tool_result"'))).toBe(false);
  }, 30_000);

  it('Codex : le processus est tué à l item.started du 51e appel, son effet et son résultat n arrivent jamais', async () => {
    const ids = Array.from({ length: BUDGET + 1 }, (_, i) => `item_${i}`);
    const state = newCodexParseState();
    const run = await runFakeCli(ids.map(codexOpenLine), codexResultLine(ids[BUDGET]!), (l) =>
      handleCodexLine(state, l) ? 1 : 0,
    );

    expect(run.toolCapExceeded).toBe(BUDGET);
    expect(run.effectHappened, 'l appel au-delà du budget a produit son effet').toBe(false);
    expect(run.linesSeen.some((l) => l.includes('item.completed'))).toBe(false);
  }, 30_000);

  it('contrôle : au budget exact, la CLI n est pas tuée et l effet a lieu', async () => {
    const ids = Array.from({ length: BUDGET }, (_, i) => `toolu_${i}`);
    const state = newStreamParseState();
    const run = await runFakeCli(
      ids.map((id) => claudeOpenLine([id])),
      claudeResultLine(ids[BUDGET - 1]!),
      (l) => countToolUses(state, l),
    );

    expect(run.toolCapExceeded).toBeUndefined();
    expect(run.effectHappened).toBe(true);
    expect(run.linesSeen.some((l) => l.includes('"tool_result"'))).toBe(true);
  }, 30_000);
});
