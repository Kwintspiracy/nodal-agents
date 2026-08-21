// builtin/code-task/providers.ts — the two CLI providers behind one interface.
//
// Pure functions only (argv construction + output parsing) so every provider
// behavior is unit-testable against RECORDED CLI output, without spawning
// anything (keyless-snapshot discipline). The spawn itself lives in process.ts.
//
// Provider asymmetries are DOCUMENTED, not papered over (invariant #4):
//   - claude reports a notional cost (total_cost_usd) even under subscription;
//     codex reports no cost at all — costUsd is null there.
//   - read/write map to different mechanisms, and this is the load-bearing
//     difference: claude hides tools via --disallowedTools (the model never
//     sees them; permission_denials stays empty), whereas codex delegates to
//     an OS sandbox (--sandbox read-only / workspace-write).
//     This comment used to say the Windows sandbox had "weaker guarantees than
//     the Linux one". Measured on 2026-08-21 (codex-cli 0.148.0): it has NONE
//     — read-only spawned a shell and wrote files, workspace-write wrote
//     outside the working directory. "Weaker" and "absent" are not the same
//     claim, and the gap between them is exactly what a user relies on. The
//     combination is now refused up front; see sandbox.ts.

import type { CliModelUsage } from '@nodal-agents/shared';

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
  /**
   * Per-model split of the run (0079) — a run can be served by several models
   * (main + CLI-spawned sub-agents). null = the provider reports no breakdown.
   */
  modelUsage: CliModelUsage[] | null;
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
 * --strict-mcp-config (claude) / --ignore-user-config (codex): a Nodal-spawned
 * run must NEVER inherit the user's personal MCP servers / claude.ai connectors
 * (A-bis finding 5, étape-A finding 5). The codex half of that claim was FALSE
 * until 2026-08-21: it used `-c 'mcp_servers={}'`, and an empty TOML table
 * merges rather than replaces — the servers, and their secrets, came through
 * anyway. Found by the PR #6 review; see the flag's comment below.
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
    // Do NOT load the owner's ~/.codex/config.toml. Auth still resolves from
    // CODEX_HOME, so the subscription keeps working — the flag's own help says
    // so, and a live run confirmed it.
    //
    // This replaces `-c 'mcp_servers={}'`, which did NOT do the job: an empty
    // TOML table MERGES with the user's config instead of replacing it. Verified
    // 2026-08-21 (PR #6 review) — `codex mcp list` and
    // `codex -c 'mcp_servers={}' mcp list` print the same servers, and a run
    // through the old argv still opened the owner's personal MCP connections,
    // secrets and all. A Nodal-spawned run must never inherit them: buildChildEnv
    // strips *KEY*/*TOKEN* from the environment, but an MCP server carries its
    // own credentials in the config file the flag now ignores.
    //
    // Measured after the change: zero MCP lines in the run's output, against two
    // before, and the turn still completed.
    '--ignore-user-config',
  ];
  if (opts.model) args.push('-m', opts.model);
  if (opts.effort) args.push('-c', `model_reasoning_effort="${opts.effort}"`);
  args.push('-');
  return args;
}

// ─── Output parsers ──────────────────────────────────────────────────────────

/** A finite number, or null when the field is ABSENT/unusable — never a
 *  guessed 0 (invariant #4). The counterpart of asNumber, which defaults to 0
 *  for fields the CLIs always emit. */
function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

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
    cacheCreationTokens: finiteOrNull(usageRaw['cache_creation_input_tokens']),
  };
}

/**
 * Per-model breakdown of a claude run (0079). The CLI reports `modelUsage` as
 * an object keyed by model id, each carrying that model's own tokens AND its
 * own notional cost — the only way to attribute a run's cost when the CLI
 * spawned sub-agents on a different tier. Note the shape asymmetry with
 * `usage` above: these keys are camelCase (cacheReadInputTokens), the
 * aggregate's are snake_case (cache_read_input_tokens) — recorded fixture,
 * not a guess. Returns null when the field is absent (older CLI, or codex,
 * which reports no breakdown at all) — never a synthesized single entry.
 */
export function extractClaudeModelUsage(raw: unknown): CliModelUsage[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: CliModelUsage[] = [];
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const u = value as Record<string, unknown>;
    out.push({
      model,
      inputTokens: asNumber(u['inputTokens']),
      outputTokens: asNumber(u['outputTokens']),
      cachedTokens: asNumber(u['cacheReadInputTokens']),
      cacheCreationTokens: finiteOrNull(u['cacheCreationInputTokens']),
      costUsd: finiteOrNull(u['costUSD']),
    });
  }
  return out.length > 0 ? out : null;
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
    modelUsage: extractClaudeModelUsage(obj['modelUsage']),
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
    // codex reports ONE aggregate usage and no model attribution at all —
    // synthesizing a single entry would invent a split it never made.
    modelUsage: null,
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
