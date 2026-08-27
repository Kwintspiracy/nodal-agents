// code-task.test.ts — the code_task builtin's pure seams (argv construction,
// CLI-output parsing, spawn shim, PATH resolution) plus its DB seams (daily
// budget, workspace write-lock) on pglite.
//
// Parser fixtures are RECORDED REAL OUTPUT from étape A / A-bis of the
// subscription-runtimes plan (2026-08-19, claude 2.1.234 / codex-cli 0.148.0)
// — keyless-snapshot discipline: the tests assert against what the CLIs
// actually printed, not against what we hope they print.

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { agents, cliRuns, workspaceLocks, eq, sql, type AnyDrizzleDb } from '@nodal-agents/db';
import {
  buildProviderArgs,
  parseClaudeOutput,
  parseCodexOutput,
  CliOutputError,
  CLAUDE_READONLY_DISALLOWED,
} from '../builtin/code-task/providers';
import { buildSpawnArgv, resolveCliPath } from '../builtin/code-task/process';
import {
  assertCliBudget,
  assertCliProviderEnabled,
  recordCliRun,
  acquireWorkspaceLock,
  releaseWorkspaceLock,
  CliBudgetExceededError,
  CliProviderDisabledError,
  WorkspaceLockedError,
  workspaceLockKey,
} from '../builtin/code-task/db';
import { buildChildEnv } from '../builtin/child-env';

// ─── Recorded fixtures (étape A / A-bis, 2026-08-19) ─────────────────────────

/** claude -p … --output-format json — successful run (job 37c60022). */
const CLAUDE_SUCCESS_JSON = `{"is_error":false,"duration_api_ms":2758,"num_turns":1,"stop_reason":"end_turn","session_id":"f57aa1f6-192f-4b78-bd30-b300bf97e233","total_cost_usd":0.18459799999999998,"usage":{"input_tokens":2,"cache_creation_input_tokens":7937,"cache_read_input_tokens":25638,"output_tokens":4,"output_tokens_details":{"thinking_tokens":0},"service_tier":"standard"},"permission_denials":[],"terminal_reason":"completed","subtype":"success","api_error_status":null,"result":"OK","type":"result","duration_ms":2966,"uuid":"0b3add2e-cb82-480e-acd6-6f303c072386"}`;

/** claude with an invalid ANTHROPIC_API_KEY — auth failure (A-bis test 1). */
const CLAUDE_AUTH_ERROR_JSON = `{"is_error":true,"duration_api_ms":0,"num_turns":1,"stop_reason":"stop_sequence","session_id":"0d44fee5-8e3e-43e7-85bf-bfcb3b3c4dfa","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0},"permission_denials":[],"terminal_reason":"api_error","subtype":"success","api_error_status":401,"result":"Failed to authenticate. API Error: 401 API key is invalid.","type":"result","duration_ms":178102,"uuid":"945f101f-b2a8-4b33-90c7-9f83406a7972"}`;

/** codex exec --json — successful run (job 7d55eaac). */
const CODEX_SUCCESS_JSONL = [
  `{"type":"thread.started","thread_id":"01a0178d-e516-7292-840f-a7a097590970"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}`,
  `{"type":"turn.completed","usage":{"input_tokens":18537,"cached_input_tokens":6912,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}`,
].join('\n');

// ─── buildProviderArgs ───────────────────────────────────────────────────────

describe('buildProviderArgs', () => {
  it('claude read: -p (prompt via STDIN), flux stream-json, strict MCP, write tools hidden', () => {
    // `json` (un objet agrege en fin de course) est devenu `stream-json
    // --verbose` : le premier ne peut PAS etre observe pendant l execution, et
    // un audit live qui parse des enveloppes stream-json contre lui ne matche
    // rien du tout — ce qui ressemble exactement a une session sans outil.
    const args = buildProviderArgs('claude', 'read');
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--strict-mcp-config',
      '--disallowedTools',
      CLAUDE_READONLY_DISALLOWED,
    ]);
    expect(CLAUDE_READONLY_DISALLOWED).toContain('Bash');
    expect(CLAUDE_READONLY_DISALLOWED).toContain('Write');
  });

  it('claude write: acceptEdits instead of disallowed tools', () => {
    const args = buildProviderArgs('claude', 'write');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('acceptEdits');
    expect(args).not.toContain('--disallowedTools');
    expect(args).toContain('--strict-mcp-config');
  });

  it('codex read: stdin sentinel `-`, sandbox read-only, personal MCP servers neutralized', () => {
    const args = buildProviderArgs('codex', 'read', { platform: 'linux' });
    expect(args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '-',
    ]);
  });

  it('codex sur WINDOWS : le mécanisme de confinement est nommé, sinon rien n’est écrit', () => {
    // Mesuré le 27/08, quatre runs, une variable à la fois. Sur Windows le bac à
    // sable par défaut n'existe pas : `--sandbox workspace-write` était bien
    // passé, le tour se terminait normalement, et le modèle répondait
    // « l'environnement interdit toute écriture » sans qu'aucune erreur
    // n'apparaisse. La seule différence avec un `codex` lancé à la main était
    // `--ignore-user-config`, qui protège les MCP personnels du propriétaire et
    // jetait ce réglage avec le reste.
    //
    // Conséquence : sur cette plateforme, ni `code_task` ni un agent en runtime
    // Codex ne pouvaient écrire QUOI QUE CE SOIT.
    const win = buildProviderArgs('codex', 'write', { platform: 'win32' });
    expect(win, 'sur Windows, aucune écriture n’aboutit').toContain('windows.sandbox="elevated"');
    // Toujours après `--ignore-user-config` : on nomme le mécanisme SANS
    // rouvrir la porte aux serveurs MCP personnels.
    expect(win).toContain('--ignore-user-config');
    // `-` reste EN DERNIER : c'est lui qui fait lire les instructions sur stdin.
    expect(win[win.length - 1]).toBe('-');

    // Ailleurs, rien à nommer : le bac à sable du système s'applique seul.
    expect(buildProviderArgs('codex', 'write', { platform: 'linux' })).not.toContain(
      'windows.sandbox="elevated"',
    );
  });

  it('la SONDE mesure le même argv que le produit', () => {
    // `scripts/probe-codex-sandbox.mjs` est du Node pur : il ne peut pas
    // importer ce constructeur et recopie l'argv à la main. Le 27/08 la copie a
    // dérivé — le produit a gagné le réglage Windows, la sonde non — et la
    // sonde a passé une journée à mesurer un argv que personne n'expédie, en
    // rapportant « aucune commande tentée ». Une sonde qui garde le produit
    // doit tenir le même langage que lui.
    const probe = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/probe-codex-sandbox.mjs'),
      'utf8',
    );
    const win = buildProviderArgs('codex', 'write', { platform: 'win32' });
    for (const flag of ['--ignore-user-config', 'windows.sandbox="elevated"']) {
      expect(win).toContain(flag);
      expect(probe, `la sonde ne passe pas ${flag}`).toContain(flag);
    }
    // Et elle ne tente PAS son évasion dans le dossier TEMP : `workspace-write`
    // l'accorde par conception, donc l'évasion « réussissait » exactement quand
    // le bac à sable fonctionnait. Une garde qui crie au feu quand tout va bien
    // pousse à fermer une fonctionnalité qui marche.
    expect(probe, 'la sonde vise TEMP, le seul endroit autorisé').toMatch(
      /const outside = join\(homedir\(\)/,
    );
  });

  it('le réglage Windows ne DESSERRE rien — il nomme, il n’autorise pas', () => {
    // ⚠️ Le garde-fou de ce correctif. Un commentaire du dépôt accusait ce
    // réglage d'avoir désactivé le confinement le 21/08 ; la mesure le
    // disculpe, et ces deux assertions fixent ce qui a été mesuré :
    //   - lecture seule + elevated → refuse d'écrire dans son propre dossier ;
    //   - écriture + elevated → refuse d'écrire hors du dossier de travail.
    // Le mode demandé reste donc ce qui décide, sur Windows comme ailleurs.
    const read = buildProviderArgs('codex', 'read', { platform: 'win32' });
    expect(read[read.indexOf('--sandbox') + 1], 'la lecture seule devient écrivable').toBe(
      'read-only',
    );
    const write = buildProviderArgs('codex', 'write', { platform: 'win32' });
    expect(write[write.indexOf('--sandbox') + 1]).toBe('workspace-write');
    // Et jamais le mode qui, lui, supprimerait vraiment le bac à sable.
    for (const args of [read, write]) {
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(args).not.toContain('danger-full-access');
    }
  });

  it('codex write: sandbox workspace-write', () => {
    const args = buildProviderArgs('codex', 'write');
    expect(args).toContain('workspace-write');
  });

  it('codex never re-introduces the mcp_servers override that did not work', () => {
    // `-c 'mcp_servers={}'` looked like it isolated the run and did not: an
    // empty TOML table MERGES with the owner's config, so their personal MCP
    // servers — and the secrets in their env blocks — came through anyway.
    // Verified 2026-08-21 via `codex mcp list` vs
    // `codex -c 'mcp_servers={}' mcp list`: identical output.
    //
    // Pinned as a NEGATIVE assertion because the failure was invisible: the
    // argv looked protective, and only a live run showed MCP traffic.
    for (const mode of ['read', 'write'] as const) {
      const args = buildProviderArgs('codex', mode);
      expect(args.join(' '), `codex/${mode} still passes the merging override`).not.toContain(
        'mcp_servers',
      );
      expect(args, `codex/${mode} must isolate from ~/.codex/config.toml`).toContain(
        '--ignore-user-config',
      );
    }
  });

  it('model/effort overrides land as flags — claude native, codex TOML override', () => {
    const claude = buildProviderArgs('claude', 'read', { model: 'opus', effort: 'high' });
    expect(claude).toContain('--model');
    expect(claude[claude.indexOf('--model') + 1]).toBe('opus');
    expect(claude[claude.indexOf('--effort') + 1]).toBe('high');

    const codex = buildProviderArgs('codex', 'read', { model: 'o3', effort: 'low' });
    expect(codex[codex.indexOf('-m') + 1]).toBe('o3');
    expect(codex).toContain('model_reasoning_effort="low"');
    // the stdin sentinel stays LAST for codex (positional prompt slot)
    expect(codex[codex.length - 1]).toBe('-');
  });

  it('omitted model/effort adds NO flags (CLI defaults untouched)', () => {
    const args = buildProviderArgs('claude', 'read');
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
  });

  it('the task NEVER appears in argv — free text is stdin-only (anti-injection)', () => {
    const hostile = 'x&whoami';
    for (const provider of ['claude', 'codex'] as const) {
      const args = buildProviderArgs(provider, 'read');
      expect(args).not.toContain(hostile);
      // and the argv is fully static apart from validated model/effort flags
      expect(args.every((a) => typeof a === 'string')).toBe(true);
    }
  });
});

// ─── Parsers (recorded real output) ──────────────────────────────────────────

describe('parseClaudeOutput', () => {
  it('parses the recorded successful run: session, cost, usage, result', () => {
    const r = parseClaudeOutput(CLAUDE_SUCCESS_JSON);
    expect(r.sessionId).toBe('f57aa1f6-192f-4b78-bd30-b300bf97e233');
    expect(r.resultText).toBe('OK');
    expect(r.costUsd).toBeCloseTo(0.184598, 5);
    expect(r.usage).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      cachedTokens: 25638,
      cacheCreationTokens: 7937,
    });
    expect(r.isError).toBe(false);
    expect(r.numTurns).toBe(1);
  });

  it('modelUsage: absent from the recorded one-shot fixture → null, never invented', () => {
    // The étape-A fixture predates modelUsage — the parser must degrade to
    // null rather than synthesize a single entry from the aggregate.
    expect(parseClaudeOutput(CLAUDE_SUCCESS_JSON).modelUsage).toBeNull();
  });

  it('parses the recorded auth failure as isError with the 401 detail', () => {
    const r = parseClaudeOutput(CLAUDE_AUTH_ERROR_JSON);
    expect(r.isError).toBe(true);
    expect(r.errorDetail).toContain('api_error');
    expect(r.errorDetail).toContain('401');
    expect(r.resultText).toContain('401');
  });

  it('fails loud on non-JSON stdout', () => {
    expect(() => parseClaudeOutput('Welcome to Claude Code!')).toThrow(CliOutputError);
  });

  it('fails loud on empty stdout', () => {
    expect(() => parseClaudeOutput('   ')).toThrow(CliOutputError);
  });

  it('fails loud on JSON that is not a result object', () => {
    expect(() => parseClaudeOutput('{"type":"system"}')).toThrow(CliOutputError);
  });
});

describe('parseCodexOutput', () => {
  it('parses the recorded successful JSONL: thread, message, usage', () => {
    const r = parseCodexOutput(CODEX_SUCCESS_JSONL);
    expect(r.sessionId).toBe('01a0178d-e516-7292-840f-a7a097590970');
    expect(r.resultText).toBe('OK');
    expect(r.costUsd).toBeNull(); // codex reports no cost — documented asymmetry
    // ...and no per-model split either: null, not a synthesized single entry.
    expect(r.modelUsage).toBeNull();
    // input normalisé HORS cache (18537 bruts - 6912 cachés) : une seule
    // sémantique dans cli_runs, quel que soit le provider.
    expect(r.usage).toEqual({
      inputTokens: 11625,
      outputTokens: 5,
      cachedTokens: 6912,
      cacheCreationTokens: 0,
    });
    expect(r.isError).toBe(false);
  });

  it('flags turn.failed as isError with the event detail', () => {
    const stream = [
      `{"type":"thread.started","thread_id":"t1"}`,
      `{"type":"turn.failed","error":{"message":"sandbox denied"}}`,
    ].join('\n');
    const r = parseCodexOutput(stream);
    expect(r.isError).toBe(true);
    expect(r.errorDetail).toContain('sandbox denied');
  });

  it('fails loud on a non-JSON line in the stream', () => {
    expect(() => parseCodexOutput('Reading additional input from stdin...')).toThrow(
      CliOutputError,
    );
  });

  it('fails loud when the stream ends without a terminal event', () => {
    const stream = `{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.started"}`;
    expect(() => parseCodexOutput(stream)).toThrow(CliOutputError);
  });
});

// ─── Spawn shim + PATH resolution ────────────────────────────────────────────

describe('buildSpawnArgv', () => {
  it('a Windows .cmd shim goes through cmd.exe with the executable in a QUOTED env var', () => {
    const { argv, envExtra } = buildSpawnArgv(
      { path: 'C:\\Users\\x\\AppData\\Roaming\\npm\\codex.cmd', isBatch: true },
      ['exec', '--json', 'tâche'],
      'win32',
    );
    expect(argv.slice(0, 5)).toEqual(['cmd.exe', '/d', '/v:off', '/s', '/c']);
    expect(argv[5]).toBe('%NODAL_CODE_TASK_EXECUTABLE%');
    // args tail stays argv — never concatenated into a shell string
    expect(argv.slice(6)).toEqual(['exec', '--json', 'tâche']);
    expect(envExtra['NODAL_CODE_TASK_EXECUTABLE']).toBe(
      '"C:\\Users\\x\\AppData\\Roaming\\npm\\codex.cmd"',
    );
  });

  it('a native .exe spawns directly with no shim', () => {
    const { argv, envExtra } = buildSpawnArgv(
      { path: 'C:\\Users\\x\\.local\\bin\\claude.exe', isBatch: false },
      ['-p', 'tâche'],
      'win32',
    );
    expect(argv).toEqual(['C:\\Users\\x\\.local\\bin\\claude.exe', '-p', 'tâche']);
    expect(envExtra).toEqual({});
  });

  it('REJECTS cmd.exe metacharacters on the shim path — the BatBadBut class fails loud', () => {
    const shim = { path: 'C:\\npm\\codex.cmd', isBatch: true };
    // `x&whoami` has no whitespace ⇒ Node passes it UNQUOTED to cmd.exe,
    // which would execute `whoami` — the exact injection the review found.
    for (const hostile of ['x&whoami', 'a|b', 'a<b', 'a>b', 'a^b', '%PATH%', 'a\nb', 'a\rb']) {
      expect(() => buildSpawnArgv(shim, ['exec', hostile], 'win32')).toThrow(/cmd_unsafe_argument/);
    }
  });

  it("accepts codex's legitimate TOML quotes on the shim path", () => {
    const shim = { path: 'C:\\npm\\codex.cmd', isBatch: true };
    const { argv } = buildSpawnArgv(shim, ['-c', 'model_reasoning_effort="high"'], 'win32');
    expect(argv).toContain('model_reasoning_effort="high"');
  });

  it('does NOT validate on the native (non-batch) path — no cmd.exe re-parse there', () => {
    const native = { path: 'C:\\bin\\claude.exe', isBatch: false };
    const { argv } = buildSpawnArgv(native, ['--resume', 'x&whoami'], 'win32');
    expect(argv).toContain('x&whoami');
  });
});

// ─── Owner provider allow-list (demande Quentin 20/08) ───────────────────────

describe('assertCliProviderEnabled', () => {
  it('refuses a disabled provider loud, naming the one still enabled', () => {
    const defaults = { codex: { enabled: false } };
    expect(() => assertCliProviderEnabled(defaults, 'codex')).toThrow(CliProviderDisabledError);
    try {
      assertCliProviderEnabled(defaults, 'codex');
    } catch (err) {
      expect((err as Error).message).toContain('provider_disabled');
      expect((err as Error).message).toContain('"claude"');
    }
  });

  it('absent config, absent entry, or enabled:true all allow (back-compat)', () => {
    expect(() => assertCliProviderEnabled(null, 'claude')).not.toThrow();
    expect(() => assertCliProviderEnabled({}, 'codex')).not.toThrow();
    expect(() => assertCliProviderEnabled({ claude: { model: 'opus' } }, 'claude')).not.toThrow();
    expect(() => assertCliProviderEnabled({ codex: { enabled: true } }, 'codex')).not.toThrow();
  });

  it('a disabled provider with defaults saved still refuses (flag wins over entry presence)', () => {
    expect(() =>
      assertCliProviderEnabled({ claude: { model: 'opus', enabled: false } }, 'claude'),
    ).toThrow(CliProviderDisabledError);
  });
});

describe('resolveCliPath', () => {
  it('finds .exe before .cmd on win32 and reports isBatch correctly', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'ct-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'ct-b-'));
    writeFileSync(join(dirB, 'claude.exe'), '');
    writeFileSync(join(dirB, 'codex.cmd'), '');
    const env = { PATH: [dirA, dirB].join(delimiter) };
    const claude = resolveCliPath('claude', env, 'win32');
    expect(claude).toEqual({ path: join(dirB, 'claude.exe'), isBatch: false });
    const codex = resolveCliPath('codex', env, 'win32');
    expect(codex).toEqual({ path: join(dirB, 'codex.cmd'), isBatch: true });
  });

  it('returns null when the binary is nowhere on PATH', () => {
    const empty = mkdtempSync(join(tmpdir(), 'ct-empty-'));
    mkdirSync(empty, { recursive: true });
    expect(resolveCliPath('claude', { PATH: empty }, 'win32')).toBeNull();
  });
});

// ─── buildChildEnv named exemptions (D0 fix) ─────────────────────────────────

describe('buildChildEnv secret-shaped extras', () => {
  it('THROWS on an unexempted secret-shaped extra instead of dropping it silently', () => {
    expect(() => buildChildEnv({ PATH: 'x' }, { ANTHROPIC_API_KEY: 'sk-ant-xxx' })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it('passes a secret-shaped extra through when exempted BY NAME', () => {
    const env = buildChildEnv(
      { PATH: 'x' },
      { ANTHROPIC_API_KEY: 'sk-ant-xxx' },
      { allowSecretExtras: ['ANTHROPIC_API_KEY'] },
    );
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-xxx');
  });

  it('still passes ordinary extras and never leaks parent secrets', () => {
    const env = buildChildEnv(
      { PATH: 'x', DATABASE_URL: 'postgres://secret' },
      { NODAL_SHARED_WORKSPACE: 'D:\\ws' },
    );
    expect(env['NODAL_SHARED_WORKSPACE']).toBe('D:\\ws');
    expect(env['DATABASE_URL']).toBeUndefined();
  });
});

// ─── DB seams: budget + workspace lock (pglite) ─────────────────────────────

describe('code_task DB seams', () => {
  let db: AnyDrizzleDb;
  let entityId: string;
  let agentId: string;
  let jobId: string;

  beforeAll(async () => {
    const res = await spinUpTestDb();
    db = res.db as unknown as AnyDrizzleDb;
    const seed = await seedMinimal(res.db);
    entityId = seed.entityId;
    agentId = seed.agentId;
    jobId = seed.jobId;
  });

  it('budget: under the cap passes; at the cap fails loud with the spent amount', async () => {
    await assertCliBudget(db, agentId); // default $10, nothing spent

    await recordCliRun(db, {
      entityId,
      agentId,
      jobId,
      provider: 'claude',
      mode: 'read',
      source: 'subscription',
      costUsd: 10.5,
      cliVersion: '2.1.234 (Claude Code)',
      exitCode: 0,
    });
    await expect(assertCliBudget(db, agentId)).rejects.toThrow(CliBudgetExceededError);
    await expect(assertCliBudget(db, agentId)).rejects.toThrow(/\$10\.50/);
  });

  it('budget 0 = uncapped (same convention as daily_token_limit)', async () => {
    await db.update(agents).set({ cliDailyBudgetUsd: 0 }).where(eq(agents.id, agentId));
    await assertCliBudget(db, agentId); // $10.50 spent, no cap → passes
    await db.update(agents).set({ cliDailyBudgetUsd: 10 }).where(eq(agents.id, agentId));
  });

  it('the budget sums cost_usd rows, not a guess: the row we wrote is really there', async () => {
    const [row] = await db
      .select({ cost: cliRuns.costUsd, provider: cliRuns.provider, source: cliRuns.source })
      .from(cliRuns)
      .where(eq(cliRuns.agentId, agentId));
    expect(row).toEqual({ cost: 10.5, provider: 'claude', source: 'subscription' });
  });

  it('workspace lock: second acquirer fails loud naming the holder; release frees it', async () => {
    const ws = 'D:\\ws\\repo';
    await acquireWorkspaceLock(db, ws, jobId, agentId);
    const otherJob = '00000000-0000-0000-0000-00000000dead';
    await expect(acquireWorkspaceLock(db, ws, otherJob, agentId)).rejects.toThrow(
      WorkspaceLockedError,
    );
    await expect(acquireWorkspaceLock(db, ws, otherJob, agentId)).rejects.toThrow(jobId);

    await releaseWorkspaceLock(db, ws, jobId);
    await acquireWorkspaceLock(db, ws, otherJob, agentId); // now free
    await releaseWorkspaceLock(db, ws, otherJob);
  });

  it('le MÊME dossier écrit autrement partage le MÊME verrou', async () => {
    // Constat de la revue Codex (27/08). Le verrou vit dans une colonne texte :
    // `C:/Common`, `c:\common` et `C:\Common\` désignent le même dossier et
    // produisaient trois verrous, dont aucun ne bloquait les autres. Deux
    // sessions en écriture pouvaient donc modifier les mêmes fichiers en même
    // temps — ce que le contrat d'un seul créneau promet d'empêcher. Le risque
    // est apparu en ouvrant les dossiers SECONDAIRES à l'écriture : jusque-là
    // chaque session ne verrouillait que son propre dossier de travail.
    const autre = '00000000-0000-0000-0000-0000000000bb';
    await acquireWorkspaceLock(db, 'C:/Common', jobId, agentId);
    for (const orthographe of ['c:\\common', 'C:\\Common\\', 'C:/COMMON']) {
      await expect(
        acquireWorkspaceLock(db, orthographe, autre, agentId),
        `"${orthographe}" ouvre un second créneau sur le même dossier`,
      ).rejects.toThrow(WorkspaceLockedError);
    }
    // Et il se REND sous n'importe laquelle de ses formes : sinon le dossier
    // resterait bloqué jusqu'à expiration.
    await releaseWorkspaceLock(db, 'c:\\common\\', jobId);
    await acquireWorkspaceLock(db, 'C:/Common', autre, agentId);
    await releaseWorkspaceLock(db, 'C:/Common', autre);
  });

  it('la casse d’un chemin POSIX reste SIGNIFICATIVE — deux dossiers, deux verrous', () => {
    // Le pendant : sur un système sensible à la casse, `/srv/App` et `/srv/app`
    // sont deux dossiers. Les confondre bloquerait un travail légitime.
    expect(workspaceLockKey('/srv/App')).not.toBe(workspaceLockKey('/srv/app'));
    expect(workspaceLockKey('C:\\Dev\\App\\')).toBe(workspaceLockKey('c:/dev/app'));
    // Un partage réseau est un chemin Windows, lui aussi insensible à la casse.
    expect(workspaceLockKey('\\\\serveur\\part\\App')).toBe(workspaceLockKey('//SERVEUR/part/app'));
  });

  it('a STALE lock (>30 min) is stolen atomically instead of wedging the workspace', async () => {
    const ws = 'D:\\ws\\stale';
    await acquireWorkspaceLock(db, ws, jobId, agentId);
    await db
      .update(workspaceLocks)
      .set({ acquiredAt: sql`now() - interval '31 minutes'` })
      .where(eq(workspaceLocks.workspacePath, workspaceLockKey(ws)));

    const thief = '00000000-0000-0000-0000-0000000000aa';
    await acquireWorkspaceLock(db, ws, thief, agentId); // steal succeeds
    const [row] = await db
      .select({ jobId: workspaceLocks.jobId })
      .from(workspaceLocks)
      .where(eq(workspaceLocks.workspacePath, workspaceLockKey(ws)));
    expect(row?.jobId).toBe(thief);

    // the original holder's release is a no-op — it no longer owns the lock
    await releaseWorkspaceLock(db, ws, jobId);
    const [still] = await db
      .select({ jobId: workspaceLocks.jobId })
      .from(workspaceLocks)
      .where(eq(workspaceLocks.workspacePath, workspaceLockKey(ws)));
    expect(still?.jobId).toBe(thief);
    await releaseWorkspaceLock(db, ws, thief);
  });
});
