// builtin/code-task/providers.ts — the two CLI providers behind one interface.
//
// Pure functions only (argv construction + output parsing) so every provider
// behavior is unit-testable against RECORDED CLI output, without spawning
// anything (keyless-snapshot discipline). The spawn itself lives in process.ts.
//
// Provider asymmetries are DOCUMENTED, not papered over (invariant #4):
//   - claude reports a notional cost (total_cost_usd) even under subscription;
//     codex reports no cost at all — costUsd is null there.
//   - read/write map to different mechanisms: claude hides tools via
//     --disallowedTools (the model never sees them; permission_denials stays
//     empty), codex delegates to its OS sandbox (--sandbox read-only /
//     workspace-write, which on Windows is a distinct restricted-token
//     implementation with weaker guarantees than the Linux one).

export type CodeTaskProvider = 'claude' | 'codex';
export type CodeTaskMode = 'read' | 'write';

/** Thrown when a CLI's output cannot be understood. Never guess (invariant #4). */
export class CliOutputError extends Error {
  constructor(
    public readonly provider: CodeTaskProvider,
    message: string,
    public readonly excerpt: string,
  ) {
    super(`${provider}: ${message} — output excerpt: ${excerpt.slice(0, 400)}`);
    this.name = 'CliOutputError';
  }
}

/** Normalized result both providers reduce to. */
export interface NormalizedCliResult {
  /** claude session_id / codex thread_id — the resume handle (étape E). */
  sessionId: string | null;
  /** The agent's final text answer. */
  resultText: string;
  /** Notional USD cost — claude only; null for codex (no cost in its JSON). */
  costUsd: number | null;
  usage: {
    /**
     * Input HORS cache, quel que soit le provider. claude rapporte déjà
     * input_tokens hors cache ; codex (sémantique OpenAI) rapporte le total
     * cache inclus — on soustrait cached_input_tokens à la normalisation
     * pour que cli_runs.input_tokens ait UNE seule sémantique.
     */
    inputTokens: number;
    outputTokens: number;
    /** Prompt-cache reads (claude cache_read / codex cached_input). */
    cachedTokens: number;
    /**
     * Prompt-cache WRITES (claude cache_creation_input_tokens / codex
     * cache_write_input_tokens) — le poste de coût dominant d'un run claude.
     * null = le champ était ABSENT du flux (jamais 0 deviné, invariant #4) ;
     * 0 = le CLI a réellement rapporté zéro écriture.
     */
    cacheCreationTokens: number | null;
  } | null;
  /** True when the CLI itself reported the run as failed. */
  isError: boolean;
  /** Provider-reported failure detail when isError (e.g. api_error_status). */
  errorDetail: string | null;
  numTurns: number | null;
}

// ─── Tool restriction sets (claude) ──────────────────────────────────────────

/**
 * Tools hidden from a read-only claude run. NOTE: --disallowedTools REMOVES
 * them from the model's palette entirely (A-bis finding 3) — the model cannot
 * even attempt them, and permission_denials stays empty. Task (sub-agents) is
 * deliberately NOT disallowed: restrictions were proven to inherit into
 * sub-agents (A-bis finding 4).
 */
export const CLAUDE_READONLY_DISALLOWED = 'Write,Edit,MultiEdit,NotebookEdit,Bash';

// ─── argv builders ───────────────────────────────────────────────────────────

/**
 * Build the argv TAIL (everything after the executable) for a one-shot run.
 * The task prompt is NOT an argv element — it goes via stdin (`claude -p`
 * reads stdin; codex gets the explicit `-` sentinel), because on the Windows
 * .cmd shim path cmd.exe re-parses argv and free text there is command
 * injection (see process.ts CMD_UNSAFE_CHARS). Proven live on both CLIs
 * (2026-08-20).
 *
 * --strict-mcp-config (claude) / mcp_servers={} (codex): a Nodal-spawned run
 * must NEVER inherit the user's personal MCP servers / claude.ai connectors
 * (A-bis finding 5, étape-A finding 5).
 */
export interface ProviderRunOptions {
  /**
   * Model/effort to request (étape B-bis) — resolved by the caller as
   * task input > agent default > undefined (CLI's own default). Free strings:
   * the CLI is the source of truth for what it accepts; a bad value fails
   * loud at run time, never silently remapped.
   */
  model?: string;
  effort?: string;
}

export function buildProviderArgs(
  provider: CodeTaskProvider,
  mode: CodeTaskMode,
  opts: ProviderRunOptions = {},
): string[] {
  if (provider === 'claude') {
    // `-p` with no inline prompt: claude reads the prompt from stdin.
    const args = ['-p', '--output-format', 'json', '--strict-mcp-config'];
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) args.push('--effort', opts.effort);
    if (mode === 'read') {
      args.push('--disallowedTools', CLAUDE_READONLY_DISALLOWED);
    } else {
      // acceptEdits: file edits inside the workspace are auto-accepted; Bash
      // still requires an approval the headless run cannot grant, so shell
      // stays effectively off. Full-permission runs are étape-E territory.
      args.push('--permission-mode', 'acceptEdits');
    }
    return args;
  }
  // codex — `-` LAST: "if `-` is used, instructions are read from stdin"
  // (codex exec --help). Effort is a TOML config override
  // (`-c model_reasoning_effort="high"`); the quotes are part of the TOML
  // string value and travel inside ONE argv element.
  const args = [
    'exec',
    '--json',
    '--sandbox',
    mode === 'read' ? 'read-only' : 'workspace-write',
    '--skip-git-repo-check',
    '-c',
    'mcp_servers={}',
  ];
  if (opts.model) args.push('-m', opts.model);
  if (opts.effort) args.push('-c', `model_reasoning_effort="${opts.effort}"`);
  args.push('-');
  return args;
}

// ─── Output parsers ──────────────────────────────────────────────────────────

/**
 * THE claude usage extractor — the one place that knows the claude result
 * JSON's usage field names. Shared by parseClaudeOutput (one-shot code_task)
 * AND the runner's stream-json finishTurn (étape E) so the two write paths of
 * cli_runs can never drift apart on semantics again.
 * cacheCreationTokens: null when the field is absent from the stream (a CLI
 * version that doesn't emit it) — NEVER a guessed 0 (invariant #4).
 */
export function extractClaudeUsage(
  usageRaw: Record<string, unknown> | undefined,
): NormalizedCliResult['usage'] {
  if (!usageRaw) return null;
  return {
    inputTokens: asNumber(usageRaw['input_tokens']),
    outputTokens: asNumber(usageRaw['output_tokens']),
    cachedTokens: asNumber(usageRaw['cache_read_input_tokens']),
    cacheCreationTokens:
      typeof usageRaw['cache_creation_input_tokens'] === 'number' &&
      Number.isFinite(usageRaw['cache_creation_input_tokens'])
        ? usageRaw['cache_creation_input_tokens']
        : null,
  };
}

/** `claude -p --output-format json` prints exactly ONE JSON object on stdout. */
export function parseClaudeOutput(stdout: string): NormalizedCliResult {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    throw new CliOutputError('claude', 'empty stdout', '');
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    throw new CliOutputError('claude', 'stdout is not valid JSON', trimmed);
  }
  if (typeof obj !== 'object' || obj === null || obj['type'] !== 'result') {
    throw new CliOutputError('claude', 'JSON is not a result object', trimmed);
  }
  const usage = extractClaudeUsage(obj['usage'] as Record<string, unknown> | undefined);
  const isError = obj['is_error'] === true;
  const apiErrorStatus = obj['api_error_status'];
  return {
    sessionId: typeof obj['session_id'] === 'string' ? obj['session_id'] : null,
    resultText: typeof obj['result'] === 'string' ? obj['result'] : '',
    costUsd: typeof obj['total_cost_usd'] === 'number' ? obj['total_cost_usd'] : null,
    usage,
    isError,
    errorDetail: isError
      ? `terminal_reason=${String(obj['terminal_reason'])}${
          apiErrorStatus != null ? ` api_error_status=${String(apiErrorStatus)}` : ''
        }`
      : null,
    numTurns: typeof obj['num_turns'] === 'number' ? obj['num_turns'] : null,
  };
}

/**
 * `codex exec --json` prints JSONL events. We require thread.started and
 * turn.completed (success) or turn.failed (failure); agent_message items
 * carry the answer. Any unparseable line fails loud — no best-effort guessing.
 */
export function parseCodexOutput(stdout: string): NormalizedCliResult {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length === 0) {
    throw new CliOutputError('codex', 'empty stdout', '');
  }
  let threadId: string | null = null;
  const messages: string[] = [];
  let usage: NormalizedCliResult['usage'] = null;
  let failed: string | null = null;
  let sawTurnCompleted = false;
  for (const line of lines) {
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new CliOutputError('codex', 'non-JSON line in JSONL stream', line);
    }
    const type = evt['type'];
    if (type === 'thread.started' && typeof evt['thread_id'] === 'string') {
      threadId = evt['thread_id'];
    } else if (type === 'item.completed') {
      const item = evt['item'] as Record<string, unknown> | undefined;
      if (item && item['type'] === 'agent_message' && typeof item['text'] === 'string') {
        messages.push(item['text']);
      }
    } else if (type === 'turn.completed') {
      sawTurnCompleted = true;
      const u = evt['usage'] as Record<string, unknown> | undefined;
      if (u) {
        // Sémantique OpenAI : input_tokens INCLUT cached_input_tokens.
        // Normalisé en input hors cache (voir NormalizedCliResult.usage).
        const rawIn = asNumber(u['input_tokens']);
        const cached = asNumber(u['cached_input_tokens']);
        usage = {
          inputTokens: Math.max(0, rawIn - cached),
          outputTokens: asNumber(u['output_tokens']),
          cachedTokens: cached,
          // cache_write_input_tokens existe dans le flux codex (fixture A) —
          // capturé quand présent, null quand absent (jamais 0 deviné).
          cacheCreationTokens:
            typeof u['cache_write_input_tokens'] === 'number'
              ? u['cache_write_input_tokens']
              : null,
        };
      }
    } else if (type === 'turn.failed' || type === 'error') {
      failed = JSON.stringify(evt).slice(0, 500);
    }
  }
  if (!sawTurnCompleted && failed === null) {
    throw new CliOutputError(
      'codex',
      'stream ended without turn.completed or turn.failed',
      lines[lines.length - 1] ?? '',
    );
  }
  return {
    sessionId: threadId,
    resultText: messages.join('\n\n'),
    costUsd: null,
    usage,
    isError: failed !== null,
    errorDetail: failed,
    numTurns: null,
  };
}

export function parseProviderOutput(
  provider: CodeTaskProvider,
  stdout: string,
): NormalizedCliResult {
  return provider === 'claude' ? parseClaudeOutput(stdout) : parseCodexOutput(stdout);
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
