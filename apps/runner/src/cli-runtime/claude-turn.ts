// cli-runtime/claude-turn.ts — one conversation turn of a RUNTIME agent
// (étape E): the agent IS a Claude Code session. Nodal spawns the user's own
// `claude` binary headless with `--output-format stream-json`, injects the
// persona from DB (--append-system-prompt-file + message via stdin — free
// text NEVER enters argv, which cmd.exe re-parses on the .cmd-shim path;
// both proven live 2026-08-20), confines the run to
// the workspace (cwd), maps the permission posture from data, resumes the
// conversation's existing session when one exists, and RELAYS the final text
// verbatim (invariant #2: the LLM speaks, Nodal relays).
//
// Live observability (Quentin's requirement, vs dsh which throws this stream
// away): every internal tool_use/tool_result event is surfaced through
// onEvent while the run is in flight — the caller persists them into
// tool_calls so the existing Runs page shows the CLI working in real time.
//
// Event shapes are validated against a RECORDED real stream
// (etapeE-stream-fixture.jsonl, claude 2.1.234, 2026-08-19):
//   {"type":"system","subtype":"init","session_id":...,"cwd":...}
//   {"type":"assistant","message":{"content":[{"type":"text"|"thinking"|"tool_use",...}]}}
//   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":...,"content":...}]}}
//   {"type":"rate_limit_event","rate_limit_info":{"status","resetsAt","rateLimitType"}}
//   {"type":"result", ...same shape as -p json...}
// Unknown types are counted, never guessed at (invariant #4) — the summary
// logs them so CLI drift is visible instead of silent.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnCliTurn } from './spawn-turn.ts';
import {
  resolveCliPath,
  buildSpawnArgv,
  buildChildEnv,
  extractClaudeUsage,
  extractClaudeModelUsage,
  CLAUDE_READONLY_DISALLOWED,
  type NormalizedCliResult,
} from '@nodal-agents/tools';

export interface ClaudeTurnEvent {
  kind: 'tool_use' | 'tool_result' | 'assistant_text';
  toolUseId?: string;
  toolName?: string;
  input?: unknown;
  /** tool_result content, stringified and capped. */
  output?: string;
  text?: string;
}

export interface ClaudeTurnResult {
  sessionId: string | null;
  finalText: string;
  isError: boolean;
  errorDetail: string | null;
  /**
   * The parsers' shared normalized shape (extractClaudeUsage — one extractor,
   * two write paths, zero drift). input HORS cache ; cacheCreationTokens null
   * quand le flux ne rapporte pas le champ (jamais 0 deviné).
   */
  usage: NormalizedCliResult['usage'];
  /**
   * Per-model split of the turn (0079) — a CLI turn can be served by several
   * models when the session spawns its own sub-agents. null = not reported.
   */
  modelUsage: NormalizedCliResult['modelUsage'];
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  /** Subscription window info when the CLI reported one (rate_limit_event). */
  rateLimit: { status: string; resetsAt: number | null; type: string | null } | null;
  /** Count of permission denials the CLI reported in its final result. */
  permissionDenials: number;
  /** Event types we did not recognize — logged, never silently dropped. */
  unknownEventTypes: string[];
}

export interface ClaudeTurnOptions {
  message: string;
  personality: string;
  cwd: string;
  /**
   * Les AUTRES dossiers attachés à l'agent, quand il en a plusieurs.
   *
   * `cwd` n'est que le premier. Un agent multi-dossiers voit les autres dans son
   * prompt et se les voit refuser à l'écriture, ce qui est le pire des deux
   * mondes (revue Codex, 27/08). Les DEUX CLI les reçoivent en `--add-dir` —
   * l'option existe des deux côtés, vérifiée sur les binaires installés.
   *
   * Le nom porte « write » parce que l'appelant les calcule pour l'écriture,
   * mais chez Claude le drapeau ouvre l'ACCÈS : ces dossiers lui sont donc
   * passés dans les deux modes, sans quoi un relecteur ne peut pas lire ce que
   * son prompt lui annonce. Chez Codex il ouvre l'écriture seule (son aide le
   * dit), donc le mode lecture n'en a pas besoin.
   */
  extraWriteDirs?: readonly string[];
  mode: 'read' | 'write';
  extraDisallowed?: string[];
  model?: string;
  effort?: string;
  resumeSessionId?: string;
  timeoutMs: number;
  /**
   * Anti-loop guard (invariant #8): kill the CLI past this many tool_use
   * events in one turn. The Nodal loop's maxToolCallsPerTurn does not see a
   * CLI-internal loop — this is its equivalent at the runtime seam.
   */
  maxToolCalls?: number;
  onEvent?: (evt: ClaudeTurnEvent) => void;
}

/**
 * Build the argv tail for one runtime turn — pure, unit-tested.
 * The user MESSAGE goes via stdin and the PERSONA via a temp file
 * (`--append-system-prompt-file`) — the two free-text fields never enter
 * argv, which cmd.exe re-parses on the Windows .cmd-shim path (command
 * injection; see process.ts CMD_UNSAFE_CHARS). Both flags proven live
 * (2026-08-20).
 */
export function buildClaudeTurnArgs(opts: ClaudeTurnOptions, personalityFile: string): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    // stream-json in print mode emits the full event stream only with
    // --verbose (verified on the recorded fixture).
    '--verbose',
    '--strict-mcp-config',
    '--append-system-prompt-file',
    personalityFile,
  ];
  // Les dossiers SECONDAIRES de l'agent (revue Codex, 27/08). `cwd` n'est que
  // le premier : le prompt annonçait les autres et la CLI n'y avait pas accès.
  // `--add-dir <directories...>` existe bien — vérifié sur le binaire installé
  // (`claude --help`), pas lu dans une doc.
  //
  // Dans les DEUX modes, et c'est une correction du tour précédent : chez
  // Claude, `--add-dir` ouvre l'ACCÈS, pas le droit d'écrire. Le limiter au
  // mode écriture privait un relecteur en lecture seule de `Read` et `Glob` sur
  // les dossiers que son propre prompt lui annonçait — un décalage silencieux
  // entre ce qu'on lui dit et ce qu'il peut. Les outils d'écriture, eux, sont
  // retirés séparément par `--disallowedTools` ; ouvrir un dossier ne les rend
  // pas.
  const extraDirs = opts.extraWriteDirs ?? [];
  if (extraDirs.length > 0) args.push('--add-dir', ...extraDirs);
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  const extra = opts.extraDisallowed ?? [];
  if (opts.mode === 'read') {
    const disallowed = [...CLAUDE_READONLY_DISALLOWED.split(','), ...extra];
    args.push('--disallowedTools', disallowed.join(','));
  } else {
    args.push('--permission-mode', 'acceptEdits');
    if (extra.length > 0) args.push('--disallowedTools', extra.join(','));
  }
  return args;
}

/** Mutable parse state threaded through handleStreamLine. */
export interface StreamParseState {
  sessionId: string | null;
  finalResult: Record<string, unknown> | null;
  rateLimit: ClaudeTurnResult['rateLimit'];
  unknownEventTypes: Set<string>;
}

export function newStreamParseState(): StreamParseState {
  return { sessionId: null, finalResult: null, rateLimit: null, unknownEventTypes: new Set() };
}

const OUTPUT_CAP = 20_000;

function stringifyCapped(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return (s ?? '').slice(0, OUTPUT_CAP);
}

/**
 * Handle ONE complete stream-json line — pure over (state, line, onEvent),
 * exported for unit tests against the recorded fixture.
 */
export function handleStreamLine(
  state: StreamParseState,
  line: string,
  onEvent?: (evt: ClaudeTurnEvent) => void,
): void {
  const trimmed = line.trim();
  if (trimmed === '') return;
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    state.unknownEventTypes.add('(non-json-line)');
    return;
  }
  if (typeof evt['session_id'] === 'string' && state.sessionId === null) {
    state.sessionId = evt['session_id'];
  }
  const type = evt['type'];
  if (type === 'system') return; // init/hooks/thinking estimates — bookkeeping
  if (type === 'rate_limit_event') {
    const info = evt['rate_limit_info'] as Record<string, unknown> | undefined;
    if (info) {
      state.rateLimit = {
        status: String(info['status'] ?? 'unknown'),
        resetsAt: typeof info['resetsAt'] === 'number' ? info['resetsAt'] : null,
        type: typeof info['rateLimitType'] === 'string' ? info['rateLimitType'] : null,
      };
    }
    return;
  }
  if (type === 'assistant' || type === 'user') {
    const message = evt['message'] as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block['type'] === 'tool_use') {
        onEvent?.({
          kind: 'tool_use',
          toolUseId: typeof block['id'] === 'string' ? block['id'] : undefined,
          toolName: typeof block['name'] === 'string' ? block['name'] : undefined,
          input: block['input'],
        });
      } else if (block['type'] === 'tool_result') {
        onEvent?.({
          kind: 'tool_result',
          toolUseId: typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : undefined,
          output: stringifyCapped(block['content']),
        });
      } else if (block['type'] === 'text' && typeof block['text'] === 'string') {
        onEvent?.({ kind: 'assistant_text', text: block['text'] });
      }
      // 'thinking' blocks: deliberately not surfaced (internal reasoning).
    }
    return;
  }
  if (type === 'result') {
    state.finalResult = evt;
    return;
  }
  state.unknownEventTypes.add(String(type));
}

/**
 * Traite une ligne et rend le NOMBRE d'appels d'outils qu'elle ouvre.
 *
 * Exporté pour être prouvable : le compte est ce qui nourrit le garde
 * anti-boucle, et la version précédente le réduisait à un booléen dans une
 * closure — Claude groupe ses appels PARALLÈLES dans un seul événement, donc
 * six appels simultanés n'en comptaient qu'un (revue Codex, 27/08). Plus le
 * modèle parallélisait, moins il consommait de budget.
 *
 * Un test sur `handleStreamLine` seul n'aurait rien prouvé de tout ça : il
 * aurait vérifié le parseur pendant que le CÂBLAGE restait faux.
 */
export function countToolUses(
  state: StreamParseState,
  line: string,
  onEvent?: (evt: ClaudeTurnEvent) => void,
): number {
  let toolUses = 0;
  handleStreamLine(state, line, (evt) => {
    if (evt.kind === 'tool_use') toolUses += 1;
    onEvent?.(evt);
  });
  return toolUses;
}

/**
 * Reduce the parse state + process outcome into the turn result.
 * `toolCapExceeded` (the cap value, when the guard fired) forces isError —
 * even if a result event raced in before the kill landed.
 */
export function finishTurn(
  state: StreamParseState,
  exitCode: number | null,
  timedOut: boolean,
  durationMs: number,
  stderrExcerpt: string,
  toolCapExceeded?: number,
): ClaudeTurnResult {
  const capDetail =
    toolCapExceeded !== undefined
      ? `tool_call_limit_exceeded: the CLI exceeded ${String(toolCapExceeded)} tool calls in one ` +
        `turn and was killed (anti-loop guard, invariant #8)`
      : null;
  const r = state.finalResult;
  if (!r) {
    return {
      sessionId: state.sessionId,
      finalText: '',
      isError: true,
      errorDetail:
        capDetail ??
        (timedOut
          ? 'cli_timeout: the run exceeded its time budget and was killed'
          : `cli_stream_incomplete: the stream ended without a result event ` +
            `(exit ${String(exitCode)}). stderr: ${stderrExcerpt.slice(0, 400)}`),
      usage: null,
      modelUsage: null,
      costUsd: null,
      numTurns: null,
      durationMs,
      exitCode,
      timedOut,
      rateLimit: state.rateLimit,
      permissionDenials: 0,
      unknownEventTypes: [...state.unknownEventTypes],
    };
  }
  const denials = Array.isArray(r['permission_denials']) ? r['permission_denials'].length : 0;
  const isError =
    r['is_error'] === true || (exitCode !== null && exitCode !== 0) || capDetail !== null;
  return {
    sessionId: typeof r['session_id'] === 'string' ? r['session_id'] : state.sessionId,
    finalText: typeof r['result'] === 'string' ? r['result'] : '',
    isError,
    errorDetail: isError
      ? (capDetail ??
        `terminal_reason=${String(r['terminal_reason'])} api_error_status=${String(r['api_error_status'])}`)
      : null,
    usage: extractClaudeUsage(r['usage'] as Record<string, unknown> | undefined),
    modelUsage: extractClaudeModelUsage(r['modelUsage']),
    costUsd: typeof r['total_cost_usd'] === 'number' ? r['total_cost_usd'] : null,
    numTurns: typeof r['num_turns'] === 'number' ? r['num_turns'] : null,
    durationMs,
    exitCode,
    timedOut,
    rateLimit: state.rateLimit,
    permissionDenials: denials,
    unknownEventTypes: [...state.unknownEventTypes],
  };
}

export class ClaudeCliNotFoundError extends Error {
  constructor() {
    super(
      'cli_not_installed: the "claude" CLI was not found on the runner machine. ' +
        'Install it (npm install -g @anthropic-ai/claude-code) and log in (`claude` then /login).',
    );
    this.name = 'ClaudeCliNotFoundError';
  }
}

/** Run one turn. Rejects only for setup failures (binary missing); every
 *  runtime failure comes back as a structured result (fail loud, not thrown). */
export async function runClaudeTurn(opts: ClaudeTurnOptions): Promise<ClaudeTurnResult> {
  const cli = resolveCliPath('claude');
  if (!cli) throw new ClaudeCliNotFoundError();

  // Persona → temp FILE, message → STDIN: the two free-text fields never
  // enter argv (cmd.exe re-parses it on the .cmd-shim path — injection).
  const personaDir = await mkdtemp(join(tmpdir(), 'nodal-cli-turn-'));
  const personaFile = join(personaDir, 'persona.txt');
  await writeFile(personaFile, opts.personality, 'utf8');

  try {
    return await spawnClaudeTurn(opts, cli, personaFile);
  } finally {
    await rm(personaDir, { recursive: true, force: true }).catch(() => {});
  }
}

function spawnClaudeTurn(
  opts: ClaudeTurnOptions,
  cli: NonNullable<ReturnType<typeof resolveCliPath>>,
  personaFile: string,
): Promise<ClaudeTurnResult> {
  const { argv, envExtra } = buildSpawnArgv(cli, buildClaudeTurnArgs(opts, personaFile));
  const env = { ...buildChildEnv(process.env), ...envExtra } as unknown as NodeJS.ProcessEnv;
  const state = newStreamParseState();

  return spawnCliTurn<ClaudeTurnResult>({
    argv,
    env,
    cwd: opts.cwd,
    stdin: opts.message,
    timeoutMs: opts.timeoutMs,
    ...(opts.maxToolCalls !== undefined ? { maxToolCalls: opts.maxToolCalls } : {}),
    // Rend le NOMBRE d'appels d'outils de la ligne : c'est ce qui nourrit le
    // garde anti-boucle, que la mécanique de processus applique sans rien
    // savoir du format des événements.
    //
    // Un COMPTE, pas un booléen (revue Codex, 27/08) : Claude groupe ses appels
    // parallèles dans un seul événement, et six appels simultanés n'en
    // comptaient qu'un. Plus le modèle parallélisait, moins il consommait de
    // budget — l'inverse exact de ce qu'un plafond doit faire.
    onLine: (line) => countToolUses(state, line, opts.onEvent),
    finish: ({ exitCode, timedOut, durationMs, stderr, toolCapExceeded }) => {
      if (state.unknownEventTypes.size > 0) {
        console.warn(
          `[cli-runtime] unknown stream event types (CLI drift?): ` +
            [...state.unknownEventTypes].join(', '),
        );
      }
      return finishTurn(state, exitCode, timedOut, durationMs, stderr, toolCapExceeded);
    },
  });
}
