// cli-runtime/claude-turn.ts — one conversation turn of a RUNTIME agent
// (étape E): the agent IS a Claude Code session. Nodal spawns the user's own
// `claude` binary headless with `--output-format stream-json`, injects the
// persona from DB (--append-system-prompt, proven A-bis), confines the run to
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

import { spawn } from 'node:child_process';
import {
  resolveCliPath,
  buildSpawnArgv,
  buildChildEnv,
  CLAUDE_READONLY_DISALLOWED,
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
  usage: {
    /** input_tokens du CLI = input HORS cache. */
    inputTokens: number;
    outputTokens: number;
    /** Lectures de cache (cache_read_input_tokens). */
    cachedTokens: number;
    /** Écritures de cache (cache_creation_input_tokens) — le poste de coût dominant. */
    cacheCreationTokens: number;
  } | null;
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
  mode: 'read' | 'write';
  extraDisallowed?: string[];
  model?: string;
  effort?: string;
  resumeSessionId?: string;
  timeoutMs: number;
  onEvent?: (evt: ClaudeTurnEvent) => void;
}

/** Build the argv tail for one runtime turn — pure, unit-tested. */
export function buildClaudeTurnArgs(opts: ClaudeTurnOptions): string[] {
  const args = [
    '-p',
    opts.message,
    '--output-format',
    'stream-json',
    // stream-json in print mode emits the full event stream only with
    // --verbose (verified on the recorded fixture).
    '--verbose',
    '--strict-mcp-config',
    '--append-system-prompt',
    opts.personality,
  ];
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

/** Reduce the parse state + process outcome into the turn result. */
export function finishTurn(
  state: StreamParseState,
  exitCode: number | null,
  timedOut: boolean,
  durationMs: number,
  stderrExcerpt: string,
): ClaudeTurnResult {
  const r = state.finalResult;
  if (!r) {
    return {
      sessionId: state.sessionId,
      finalText: '',
      isError: true,
      errorDetail: timedOut
        ? 'cli_timeout: the run exceeded its time budget and was killed'
        : `cli_stream_incomplete: the stream ended without a result event ` +
          `(exit ${String(exitCode)}). stderr: ${stderrExcerpt.slice(0, 400)}`,
      usage: null,
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
  const usageRaw = r['usage'] as Record<string, unknown> | undefined;
  const denials = Array.isArray(r['permission_denials']) ? r['permission_denials'].length : 0;
  const isError = r['is_error'] === true || (exitCode !== null && exitCode !== 0);
  return {
    sessionId: typeof r['session_id'] === 'string' ? r['session_id'] : state.sessionId,
    finalText: typeof r['result'] === 'string' ? r['result'] : '',
    isError,
    errorDetail: isError
      ? `terminal_reason=${String(r['terminal_reason'])} api_error_status=${String(r['api_error_status'])}`
      : null,
    usage: usageRaw
      ? {
          inputTokens: num(usageRaw['input_tokens']),
          outputTokens: num(usageRaw['output_tokens']),
          cachedTokens: num(usageRaw['cache_read_input_tokens']),
          cacheCreationTokens: num(usageRaw['cache_creation_input_tokens']),
        }
      : null,
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

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
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
export function runClaudeTurn(opts: ClaudeTurnOptions): Promise<ClaudeTurnResult> {
  const cli = resolveCliPath('claude');
  if (!cli) throw new ClaudeCliNotFoundError();
  const { argv, envExtra } = buildSpawnArgv(cli, buildClaudeTurnArgs(opts));
  const [command, ...rest] = argv;
  const env = { ...buildChildEnv(process.env), ...envExtra };
  const isWindows = process.platform === 'win32';
  const startedAt = Date.now();

  return new Promise<ClaudeTurnResult>((resolve) => {
    const child = spawn(command as string, rest, {
      cwd: opts.cwd,
      shell: false,
      detached: !isWindows,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env as unknown as NodeJS.ProcessEnv,
    });

    const state = newStreamParseState();
    let stdoutBuffer = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, nl);
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        try {
          handleStreamLine(state, line, opts.onEvent);
        } catch (err) {
          console.warn('[cli-runtime] stream line handling failed:', err);
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 50_000) stderr += chunk.toString('utf8');
    });

    const killTree = (): void => {
      if (child.pid) {
        if (isWindows) {
          try {
            spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
          } catch {
            /* fall through */
          }
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* already dead */
          }
        }
      }
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    };

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      // Flush a trailing unterminated line (the result line usually ends with \n,
      // but never assume).
      if (stdoutBuffer.trim() !== '') handleStreamLine(state, stdoutBuffer, opts.onEvent);
      if (state.unknownEventTypes.size > 0) {
        console.warn(
          `[cli-runtime] unknown stream event types (CLI drift?): ` +
            [...state.unknownEventTypes].join(', '),
        );
      }
      resolve(finishTurn(state, exitCode, timedOut, Date.now() - startedAt, stderr));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      graceTimer = setTimeout(() => finish(null), 3000);
    }, opts.timeoutMs);

    child.on('error', (err: Error) => {
      stderr += `\nspawn_error: ${err.message}`;
      finish(null);
    });
    child.on('close', (code: number | null) => finish(code));
  });
}
