// claude-turn.test.ts — the runtime-agent stream parser and argv builder
// (étape E), validated against a RECORDED REAL stream from claude 2.1.234
// (stream-fixture.jsonl, captured 2026-08-19): keyless-snapshot discipline —
// the parser is tested on what the CLI actually printed.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildClaudeTurnArgs,
  handleStreamLine,
  newStreamParseState,
  finishTurn,
  type ClaudeTurnEvent,
} from '../../cli-runtime/claude-turn.ts';

const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'stream-fixture.jsonl'),
  'utf8',
);

describe('handleStreamLine on the recorded real stream', () => {
  it('extracts session, live tool events, and the final result', () => {
    const state = newStreamParseState();
    const events: ClaudeTurnEvent[] = [];
    for (const line of FIXTURE.split('\n')) {
      handleStreamLine(state, line, (e) => events.push(e));
    }

    expect(state.sessionId).toBe('8c97f2a2-2ed9-4453-b193-15848ae3a3e5');

    const toolUses = events.filter((e) => e.kind === 'tool_use');
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]!.toolName).toBe('Read');
    expect(toolUses[0]!.toolUseId).toMatch(/^toolu_/);
    expect(JSON.stringify(toolUses[0]!.input)).toContain('calc.js');

    const toolResults = events.filter((e) => e.kind === 'tool_result');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.toolUseId).toBe(toolUses[0]!.toolUseId);
    expect(toolResults[0]!.output).toContain('function add');

    // The subscription window event is captured, not dropped.
    expect(state.rateLimit).not.toBeNull();
    expect(state.rateLimit!.status).toBe('allowed');
    expect(state.rateLimit!.type).toBe('five_hour');

    // No unknown event types on the recorded stream — drift would show here.
    expect([...state.unknownEventTypes]).toEqual([]);

    const result = finishTurn(state, 0, false, 6000, '');
    expect(result.isError).toBe(false);
    expect(result.finalText).toContain('calc.js');
    expect(result.numTurns).toBe(2);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.usage!.inputTokens).toBeGreaterThan(0);
    // Les écritures de cache — le poste de coût dominant — sont extraites du
    // result event (audit tokens 19/08), pas devinées.
    expect(result.usage!.cacheCreationTokens).toBe(31725);
    // Ventilation PAR MODÈLE (0079) — extraite du modelUsage du result event
    // (clés camelCase, contrairement à l'agrégat snake_case), avec son coût.
    expect(result.modelUsage).toEqual([
      {
        model: 'claude-fable-5',
        inputTokens: 4,
        outputTokens: 224,
        cachedTokens: 31452,
        cacheCreationTokens: 31725,
        costUsd: 0.677192,
      },
    ]);
    expect(result.sessionId).toBe('8c97f2a2-2ed9-4453-b193-15848ae3a3e5');
  });

  it('a stream that ends without a result event fails loud', () => {
    const state = newStreamParseState();
    handleStreamLine(state, '{"type":"system","subtype":"init","session_id":"s1"}');
    const result = finishTurn(state, 1, false, 100, 'boom');
    expect(result.isError).toBe(true);
    expect(result.errorDetail).toContain('cli_stream_incomplete');
    expect(result.sessionId).toBe('s1');
  });

  it('unknown event types are collected, never silently dropped', () => {
    const state = newStreamParseState();
    handleStreamLine(state, '{"type":"brand_new_event_kind"}');
    expect([...state.unknownEventTypes]).toEqual(['brand_new_event_kind']);
  });
});

describe('finishTurn anti-loop guard (invariant #8)', () => {
  it('a hit cap forces isError with tool_call_limit_exceeded — even if a result raced in', () => {
    const state = newStreamParseState();
    for (const line of FIXTURE.split('\n')) handleStreamLine(state, line);
    // The fixture ends with a real successful result event; the cap verdict
    // must still win — the run was killed, its "result" is not trustworthy.
    const result = finishTurn(state, null, false, 500, '', 50);
    expect(result.isError).toBe(true);
    expect(result.errorDetail).toContain('tool_call_limit_exceeded');
    expect(result.errorDetail).toContain('50');
  });

  it('a killed stream with no result event reports the cap, not cli_stream_incomplete', () => {
    const state = newStreamParseState();
    handleStreamLine(state, '{"type":"system","subtype":"init","session_id":"s1"}');
    const result = finishTurn(state, null, false, 100, '', 50);
    expect(result.isError).toBe(true);
    expect(result.errorDetail).toContain('tool_call_limit_exceeded');
  });
});

describe('buildClaudeTurnArgs', () => {
  const base = {
    message: 'salut',
    personality: 'Tu es Jarvis.',
    cwd: 'D:\\ws',
    mode: 'read' as const,
    timeoutMs: 1000,
  };
  const PERSONA_FILE = 'D:\\tmp\\persona.txt';

  it('read mode: prompt via STDIN (bare -p), persona via FILE, write tools hidden', () => {
    const args = buildClaudeTurnArgs(base, PERSONA_FILE);
    // Anti-injection contract: neither free-text field may appear in argv.
    expect(args).not.toContain('salut');
    expect(args).not.toContain('Tu es Jarvis.');
    expect(args[0]).toBe('-p');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--append-system-prompt-file') + 1]).toBe(PERSONA_FILE);
    const disallowed = args[args.indexOf('--disallowedTools') + 1]!;
    expect(disallowed).toContain('Write');
    expect(disallowed).toContain('Bash');
    expect(args).not.toContain('--permission-mode');
  });

  it('write mode uses acceptEdits; extras still land in disallowed', () => {
    const args = buildClaudeTurnArgs(
      { ...base, mode: 'write', extraDisallowed: ['WebSearch'] },
      PERSONA_FILE,
    );
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('WebSearch');
  });

  it('les dossiers SECONDAIRES sont ouverts en écriture (--add-dir)', () => {
    // Constat P2 de la revue Codex (27/08). Le prompt annonce les autres
    // dossiers de l'agent et l'appelant les transmet, mais l'argv les jetait :
    // en mode écriture, la CLI se voyait refuser des chemins qu'on venait de
    // lui promettre. L'option existe — vérifiée sur le binaire installé.
    const args = buildClaudeTurnArgs(
      { ...base, mode: 'write' as const, extraWriteDirs: ['C:/Dev/autre', 'C:/Notes'] },
      PERSONA_FILE,
    );
    const i = args.indexOf('--add-dir');
    expect(i, 'les dossiers secondaires sont annoncés mais pas ouverts').toBeGreaterThan(-1);
    expect(args.slice(i + 1, i + 3)).toEqual(['C:/Dev/autre', 'C:/Notes']);

    // En lecture seule il n'y a rien à ouvrir : les outils d'écriture sont déjà
    // retirés au modèle.
    expect(buildClaudeTurnArgs({ ...base, extraWriteDirs: ['C:/x'] }, PERSONA_FILE)).not.toContain(
      '--add-dir',
    );
  });

  it('resume, model and effort flags appear only when provided', () => {
    const bare = buildClaudeTurnArgs(base, PERSONA_FILE);
    expect(bare).not.toContain('--resume');
    expect(bare).not.toContain('--model');
    const full = buildClaudeTurnArgs(
      {
        ...base,
        resumeSessionId: 'sess-1',
        model: 'opus',
        effort: 'high',
      },
      PERSONA_FILE,
    );
    expect(full[full.indexOf('--resume') + 1]).toBe('sess-1');
    expect(full[full.indexOf('--model') + 1]).toBe('opus');
    expect(full[full.indexOf('--effort') + 1]).toBe('high');
  });
});
