// spawn-turn-tool-cap.test.ts — le budget d'appels d'UNE réponse du modèle sur
// un runtime CLI (invariant #8, revue Codex de #568, #1177).
//
// L'unité est la réponse du modèle, jamais la session : une session de CLI est
// toute la boucle d'une demande, et la compter entière tuait au 51e appel un
// travail que la boucle de Nodal mène sur cinquante réponses. Claude nomme ses
// réponses (`message.id`, le même sur chaque bloc d'une réponse) ; Codex n'en
// nomme aucune, et ses appels ne sont donc pas comptés.
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

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openProcessScope } from '@nodal-agents/sandbox';
import { spawnCliTurn, type ToolCallGate } from '../../cli-runtime/spawn-turn.ts';
import { countToolUses, newStreamParseState } from '../../cli-runtime/claude-turn.ts';
import { handleCodexLine, newCodexParseState } from '../../cli-runtime/codex-turn.ts';
import { DEFAULT_LIMITS } from '@nodal-agents/orchestration';

// La CLI tourne dans un périmètre de processus, comme dans un job (#750).
const scope = openProcessScope(`spawn-turn-test:${randomUUID()}`);
afterAll(() => scope.close());

const BUDGET = DEFAULT_LIMITS.maxToolCallsPerTurn;

/**
 * Une ligne d'appel au format stream-json de Claude (un ou plusieurs blocs
 * parallèles), dans la réponse `responseId` : Claude émet un événement par bloc,
 * et tous les blocs d'une réponse portent le même `message.id`.
 */
function claudeOpenLine(ids: string[], responseId: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: responseId,
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
  onLine: (line: string, gate: ToolCallGate) => void,
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
    processScope: scope,
    timeoutMs: 60_000,
    maxToolCalls: BUDGET,
    onLine: (line, gate) => {
      linesSeen.push(line);
      onLine(line, gate);
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

describe('spawnCliTurn — budget d appels d une réponse du modèle sur un runtime CLI @cap:suivre-execution/moteur', () => {
  it('Claude : 51 appels dans UNE réponse, le processus est tué à l ouverture du 51e, son effet et son résultat n arrivent jamais', async () => {
    // 45 appels un à un, puis 6 parallèles dans UN événement (45 + 6 = 51), tous
    // dans la même réponse du modèle.
    const ids = Array.from({ length: BUDGET + 1 }, (_, i) => `toolu_${i}`);
    const opens = [
      ...ids.slice(0, 45).map((id) => claudeOpenLine([id], 'msg_one')),
      claudeOpenLine(ids.slice(45), 'msg_one'),
    ];
    const state = newStreamParseState();
    const run = await runFakeCli(opens, claudeResultLine(ids[BUDGET]!), (l, g) => {
      countToolUses(state, l, undefined, g);
    });

    expect(run.toolCapExceeded).toBe(BUDGET);
    expect(run.effectHappened, 'l appel au-delà du budget a produit son effet').toBe(false);
    expect(run.linesSeen.some((l) => l.includes('"tool_result"'))).toBe(false);
  }, 30_000);

  it('Claude : 120 appels répartis sur dix réponses ne sont pas tués, l effet du dernier a lieu', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `toolu_${i}`);
    // Douze appels par réponse : dix réponses, chacune sous le budget, et
    // 120 au total, plus du double du budget d'une réponse.
    const opens = ids.map((id, i) => claudeOpenLine([id], `msg_${Math.floor(i / 12)}`));
    const state = newStreamParseState();
    const run = await runFakeCli(opens, claudeResultLine(ids[119]!), (l, g) => {
      countToolUses(state, l, undefined, g);
    });

    expect(run.toolCapExceeded).toBeUndefined();
    expect(run.effectHappened).toBe(true);
    expect(run.linesSeen.some((l) => l.includes('"tool_result"'))).toBe(true);
  }, 30_000);

  it('Codex : un flux qui ne nomme aucune réponse n est pas compté, 120 appels passent et l effet a lieu', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `item_${i}`);
    const state = newCodexParseState();
    const run = await runFakeCli(ids.map(codexOpenLine), codexResultLine(ids[119]!), (l, g) => {
      handleCodexLine(state, l, undefined, g);
    });

    expect(run.toolCapExceeded).toBeUndefined();
    expect(run.effectHappened).toBe(true);
    expect(run.linesSeen.some((l) => l.includes('item.completed'))).toBe(true);
  }, 30_000);

  it('contrôle : au budget exact dans une réponse, la CLI n est pas tuée et l effet a lieu', async () => {
    const ids = Array.from({ length: BUDGET }, (_, i) => `toolu_${i}`);
    const state = newStreamParseState();
    const run = await runFakeCli(
      ids.map((id) => claudeOpenLine([id], 'msg_one')),
      claudeResultLine(ids[BUDGET - 1]!),
      (l, g) => {
        countToolUses(state, l, undefined, g);
      },
    );

    expect(run.toolCapExceeded).toBeUndefined();
    expect(run.effectHappened).toBe(true);
    expect(run.linesSeen.some((l) => l.includes('"tool_result"'))).toBe(true);
  }, 30_000);

  // Revue Codex de #568, passes 2 et 3 (P1). Le kill est asynchrone : les
  // lignes déjà reçues (le même paquet stdout, ou ce qui arrive pendant le
  // taskkill Windows) sont encore là. Passe 2 : rien de NOUVEAU ne doit en
  // sortir (aucune ouverture, aucune fin de tour, rien du 51e appel). Passe 3 :
  // mais le résultat d'un appel SOUS le budget, ouvert avant le cap et fini
  // après, doit arriver, sinon l'audit (une ligne tool_calls par résultat)
  // perd un appel qui a pu écrire dans le dossier. Après le cap, seuls passent
  // les résultats des appels admis.
  async function runOnePacket(
    packet: string[],
    onLine: (line: string, gate: ToolCallGate) => void,
  ): Promise<{ toolCapExceeded?: number; toolCapCalls?: number }> {
    const script = join(dir, 'fake-cli-packet.cjs');
    await writeFile(
      script,
      [
        // UNE seule écriture : le runner reçoit tout le paquet d'un coup.
        `process.stdout.write(${JSON.stringify(packet.join('\n') + '\n')});`,
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    const outcome = await spawnCliTurn({
      argv: [process.execPath, script],
      env: process.env,
      cwd: dir,
      stdin: '',
      processScope: scope,
      timeoutMs: 60_000,
      maxToolCalls: BUDGET,
      onLine,
      finish: (o) => o,
    });
    return outcome.toolCapExceeded !== undefined
      ? {
          toolCapExceeded: outcome.toolCapExceeded,
          ...(outcome.toolCapCalls !== undefined ? { toolCapCalls: outcome.toolCapCalls } : {}),
        }
      : {};
  }

  it('Claude, un seul paquet et des appels parallèles : les appels admis du lot ont leur résultat, pas le 51e', async () => {
    // Une première réponse de 30 appels, puis une seconde : 45 appels un à
    // un et 6 parallèles dans UN événement. Les 5 premiers du lot sont sous le
    // budget de LEUR réponse, le 6e (le 51e de la réponse) au-delà. La
    // première réponse ne compte pas pour la seconde.
    const first = Array.from({ length: 30 }, (_, i) => `toolu_a${i}`);
    const ids = Array.from({ length: BUDGET + 1 }, (_, i) => `toolu_${i}`);
    const packet = [
      ...first.flatMap((id) => [claudeOpenLine([id], 'msg_a'), claudeResultLine(id)]),
      ...ids.slice(0, 45).map((id) => claudeOpenLine([id], 'msg_b')),
      claudeOpenLine(ids.slice(45), 'msg_b'),
      claudeResultLine(ids[47]!),
      claudeResultLine(ids[BUDGET]!),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }),
    ];
    const state = newStreamParseState();
    const events: Array<{ kind: string; toolUseId?: string }> = [];
    const run = await runOnePacket(packet, (l, g) => {
      countToolUses(state, l, (e) => events.push(e), g);
    });

    expect(run.toolCapExceeded).toBe(BUDGET);
    // Les appels comptés dans la réponse qui a dépassé : les 51 de `msg_b`.
    expect(run.toolCapCalls).toBe(BUDGET + 1);
    expect(events.filter((e) => e.kind === 'tool_result').map((e) => e.toolUseId)).toEqual([
      ...first,
      ids[47],
    ]);
    expect(events.filter((e) => e.toolUseId === ids[BUDGET])).toEqual([]);
    expect(events.filter((e) => e.kind === 'tool_use')).toHaveLength(30 + BUDGET);
    expect(state.finalResult).toBeNull();
  }, 30_000);
});
