// builtin/code-task/doctor.ts — diagnose a coding-CLI installation.
//
// Three distinct states the UI must tell apart (étape-A finding 6: on the
// reference machine codex had VANISHED from PATH while its login survived —
// "binary absent" and "not logged in" are different problems with different
// copy-paste fixes):
//   1. binary absent          → install hint
//   2. binary present, version → recorded
//   3. logged in?             → codex: real check (`codex login status`, free);
//                               claude: 'unknown' — there is no free probe, and
//                               reading ~/.claude/* is off-limits (D0 red line:
//                               Nodal never touches credentials, not even to
//                               peek). Honest 'unknown' beats a fake green.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildChildEnv } from '../child-env';
import { resolveCliPath, runCli } from './process';
import type { CodeTaskProvider } from './providers';

export interface CliDoctorReport {
  provider: CodeTaskProvider;
  binaryFound: boolean;
  /** Absolute path when found. */
  path: string | null;
  /** Raw `--version` output when it ran (e.g. "2.1.234 (Claude Code)"). */
  version: string | null;
  /** 'yes' | 'no' | 'unknown' — claude has no free login probe. */
  loggedIn: 'yes' | 'no' | 'unknown';
  /** One actionable instruction when something is wrong; null when healthy. */
  fix: string | null;
  /**
   * Model choices for the defaults dropdown. claude: the CLI's stable aliases
   * (a full model name is still accepted via free entry). codex: read from
   * the CLI's OWN local cache (~/.codex/models_cache.json — model metadata,
   * no credentials); null when the cache is absent/unreadable.
   */
  models: string[] | null;
  /**
   * Valid reasoning-effort levels, PROBED on 2026-08-19: claude enumerates
   * them in its own --effort warning ("Valid values: low, medium, high,
   * xhigh, max"); codex's API returned its enum in an invalid_enum_value
   * error ("none, minimal, low, medium, high, xhigh, max").
   */
  efforts: string[];
}

/** claude model ALIASES (stable CLI feature; full model names typed freely). */
const CLAUDE_MODEL_ALIASES = ['opus', 'sonnet', 'haiku'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** codex's own model list, from its local metadata cache. Never throws. */
function readCodexModelCache(): string[] | null {
  try {
    const raw = readFileSync(join(homedir(), '.codex', 'models_cache.json'), 'utf8');
    const parsed = JSON.parse(raw) as { models?: Array<{ slug?: string; id?: string }> };
    if (!Array.isArray(parsed.models)) return null;
    const slugs = parsed.models
      .map((m) => m.slug ?? m.id)
      .filter((s): s is string => typeof s === 'string' && s !== '');
    return slugs.length > 0 ? slugs : null;
  } catch {
    return null;
  }
}

const INSTALL_HINTS: Record<CodeTaskProvider, string> = {
  claude:
    'Claude Code was not found on the runner machine. In a terminal, run: npm install -g @anthropic-ai/claude-code',
  codex:
    'Codex was not found on the runner machine. In a terminal, run: npm install -g @openai/codex',
};

const LOGIN_HINTS: Record<CodeTaskProvider, string> = {
  claude: 'In a terminal, run: claude — then /login',
  codex: 'In a terminal, run: codex login',
};

/**
 * Probe one provider's CLI. Never throws — a doctor that crashes is a doctor
 * that lied about state 1. Spawns at most two short commands (`--version`,
 * and for codex `login status`), each with a 15 s timeout.
 */
export async function runCliDoctor(provider: CodeTaskProvider): Promise<CliDoctorReport> {
  const bin = provider === 'claude' ? 'claude' : 'codex';
  const resolved = resolveCliPath(bin);
  if (!resolved) {
    return {
      provider,
      binaryFound: false,
      path: null,
      version: null,
      loggedIn: 'unknown',
      fix: INSTALL_HINTS[provider],
      ...providerCatalog(provider),
    };
  }

  const env = buildChildEnv(process.env);
  const versionRun = await runCli(resolved, ['--version'], {
    cwd: process.cwd(),
    timeoutMs: 15_000,
    env,
  });
  const version =
    versionRun.exitCode === 0 && versionRun.stdout.trim() !== ''
      ? versionRun.stdout.trim().split('\n')[0]!.trim()
      : null;
  if (version === null) {
    return {
      provider,
      binaryFound: true,
      path: resolved.path,
      version: null,
      loggedIn: 'unknown',
      fix:
        `The ${bin} binary is present (${resolved.path}) but \`${bin} --version\` failed ` +
        `(exit ${String(versionRun.exitCode)}${versionRun.timedOut ? ', timeout' : ''}). ` +
        `Reinstalling the CLI is the most likely fix.`,
      ...providerCatalog(provider),
    };
  }

  if (provider === 'codex') {
    const loginRun = await runCli(resolved, ['login', 'status'], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
      env,
    });
    const loggedIn =
      loginRun.exitCode === 0 && /logged in/i.test(loginRun.stdout + loginRun.stderr);
    return {
      provider,
      binaryFound: true,
      path: resolved.path,
      version,
      loggedIn: loggedIn ? 'yes' : 'no',
      fix: loggedIn ? null : LOGIN_HINTS[provider],
      ...providerCatalog(provider),
    };
  }

  // claude: no free login probe (a `claude -p` costs real usage; peeking at
  // ~/.claude is the D0 red line). 'unknown' + no fix = healthy-as-far-as-
  // checkable; the first real run surfaces an auth failure loudly anyway.
  return {
    provider,
    binaryFound: true,
    path: resolved.path,
    version,
    loggedIn: 'unknown',
    fix: null,
    ...providerCatalog(provider),
  };
}

/** Dropdown material per provider — the machine's own lists, never a stale web catalog. */
function providerCatalog(provider: CodeTaskProvider): {
  models: string[] | null;
  efforts: string[];
} {
  return provider === 'claude'
    ? { models: CLAUDE_MODEL_ALIASES, efforts: CLAUDE_EFFORTS }
    : { models: readCodexModelCache(), efforts: CODEX_EFFORTS };
}
