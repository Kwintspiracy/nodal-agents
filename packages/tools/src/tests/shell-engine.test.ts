// shell-engine.test.ts — le moteur d'exécution, éprouvé sur de VRAIS processus
// (issue typée, tree-kill du petit-enfant, quoting, env scrubbé, plafonds,
// décodage UTF-8). `process.execPath` partout : node est toujours présent, et
// son chemin contient un espace sur Windows (C:\Program Files\nodejs) — c'est
// le cas de quoting qui compte.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShellCommand, DEFAULT_MAX_OUTPUT_CHARS } from '../builtin/shell-engine';
import { buildChildEnv } from '../builtin/child-env';

let dir: string;
const orphans: number[] = [];
const node = process.execPath;
const env = buildChildEnv(process.env);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nodal-engine-'));
});

afterAll(async () => {
  for (const pid of orphans) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* déjà mort */
    }
  }
  for (let i = 0; i < 5; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
});

/** Un script node dans le dossier de test — évite tout quoting de `-e` à travers un shell. */
async function script(name: string, body: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, body, 'utf8');
  return p;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('runShellCommand — issue typée', () => {
  it('exit 0 : outcome exit, stdout capturé, durationMs mesuré', async () => {
    const p = await script('ok.js', "process.stdout.write('hello-engine')");
    const r = await runShellCommand({
      target: { file: node, args: [p] },
      cwd: dir,
      timeoutMs: 20_000,
      env,
    });
    expect(r.outcome).toEqual({ kind: 'exit', exitCode: 0 });
    expect(r.stdout).toBe('hello-engine');
    expect(r.truncatedStdout).toBe(false);
    expect(r.durationMs).toBeGreaterThan(0);
    expect(r.durationMs).toBeLessThan(20_000);
    expect(r.cwd).toBe(dir);
  });

  it('exit ≠ 0 : le code est rendu tel quel, stderr capturé', async () => {
    const p = await script('fail.js', "process.stderr.write('boom'); process.exit(3)");
    const r = await runShellCommand({
      target: { file: node, args: [p] },
      cwd: dir,
      timeoutMs: 20_000,
      env,
    });
    expect(r.outcome).toEqual({ kind: 'exit', exitCode: 3 });
    expect(r.stderr).toBe('boom');
  });

  it('timeout : outcome timeout — jamais une assertion sur exitCode', async () => {
    const p = await script('sleep.js', 'setTimeout(() => {}, 60000)');
    const r = await runShellCommand({
      target: { file: node, args: [p] },
      cwd: dir,
      timeoutMs: 500,
      env,
    });
    expect(r.outcome.kind).toBe('timeout');
  });

  it('spawn_error : cwd inexistant ⇒ kind spawn_error avec message, stderr vide', async () => {
    const r = await runShellCommand({
      target: { file: node, args: ['-e', '1'] },
      cwd: join(dir, 'nulle-part'),
      timeoutMs: 5_000,
      env,
    });
    expect(r.outcome.kind).toBe('spawn_error');
    if (r.outcome.kind === 'spawn_error') expect(r.outcome.message.length).toBeGreaterThan(0);
    expect(r.stderr).toBe('');
  });

  it('env absent ⇒ ENV_REQUIRED (le moteur refuse process.env implicite)', () => {
    expect(() =>
      runShellCommand({
        target: { command: 'echo x' },
        cwd: dir,
        timeoutMs: 1000,
        env: undefined as unknown as Record<string, string>,
      }),
    ).toThrow('ENV_REQUIRED');
  });
});

describe('runShellCommand — tree-kill : le petit-enfant est mort', () => {
  it('à travers le shell, le processus node lancé par cmd.exe / sh ne survit pas au timeout', async () => {
    const p = await script(
      'pid-sleep.js',
      'process.stdout.write(String(process.pid)); setTimeout(() => {}, 60000)',
    );
    const r = await runShellCommand({
      target: { command: `"${node}" "${p}"` },
      cwd: dir,
      timeoutMs: 1_000,
      env,
    });
    expect(r.outcome.kind).toBe('timeout');
    const pid = Number(r.stdout.trim());
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    await new Promise((res) => setTimeout(res, 1_500));
    const still = alive(pid);
    if (still) orphans.push(pid);
    expect(still).toBe(false);
  });
});

describe('runShellCommand — quoting à travers le shell', () => {
  it('un exécutable dont le chemin contient un espace, et une commande composée', async () => {
    const p = await script('quoted.js', "process.stdout.write('quoted-ok')");
    const r = await runShellCommand({
      target: { command: `"${node}" "${p}" && "${node}" "${p}"` },
      cwd: dir,
      timeoutMs: 20_000,
      env,
    });
    expect(r.outcome).toEqual({ kind: 'exit', exitCode: 0 });
    expect(r.stdout).toBe('quoted-okquoted-ok');
  });

  it('une variable inconnue reste littérale sur win32 (%VAR%) et vide sur Unix ($VAR) — le shell attendu est bien celui-là', async () => {
    const isWin = process.platform === 'win32';
    const p = await script('echo-argv.js', 'process.stdout.write(process.argv.slice(2).join("|"))');
    const r = await runShellCommand({
      target: {
        command: isWin
          ? `"${node}" "${p}" %NODAL_TEST_UNSET%`
          : `"${node}" "${p}" "$NODAL_TEST_UNSET"`,
      },
      cwd: dir,
      timeoutMs: 20_000,
      env,
    });
    expect(r.outcome).toEqual({ kind: 'exit', exitCode: 0 });
    expect(r.stdout).toBe(isWin ? '%NODAL_TEST_UNSET%' : '');
  });
});

describe('runShellCommand — env scrubbé', () => {
  it('DATABASE_URL et WORKER_SECRET du parent n’atteignent pas l’enfant ; PATH oui', async () => {
    const p = await script('env.js', 'process.stdout.write(JSON.stringify(process.env))');
    const source = { ...process.env, DATABASE_URL: 'postgres://x', WORKER_SECRET: 's3cret' };
    const r = await runShellCommand({
      target: { file: node, args: [p] },
      cwd: dir,
      timeoutMs: 20_000,
      env: buildChildEnv(source),
    });
    expect(r.outcome).toEqual({ kind: 'exit', exitCode: 0 });
    const seen = JSON.parse(r.stdout) as Record<string, string>;
    expect(seen['DATABASE_URL']).toBeUndefined();
    expect(seen['WORKER_SECRET']).toBeUndefined();
    const pathKey = Object.keys(seen).find((k) => k.toUpperCase() === 'PATH');
    expect(pathKey).toBeDefined();
  });
});

describe('runShellCommand — plafonds et décodage', () => {
  it('keep head : les premiers caractères, truncatedStdout', async () => {
    const p = await script('big.js', "process.stdout.write('A'.repeat(200000) + 'Z')");
    const r = await runShellCommand({
      target: { file: node, args: [p] },
      cwd: dir,
      timeoutMs: 20_000,
      env,
      keep: 'head',
      maxChars: 50_000,
    });
    expect(r.stdout.length).toBe(50_000);
    expect(r.stdout.endsWith('A')).toBe(true);
    expect(r.truncatedStdout).toBe(true);
  });

  it('keep tail : contient la DERNIÈRE ligne écrite — c’est là que l’erreur d’un test vit', async () => {
    const p = await script(
      'big-tail.js',
      "process.stdout.write('A'.repeat(200000)); process.stdout.write('\\nLAST-LINE-MARKER')",
    );
    const r = await runShellCommand({
      target: { file: node, args: [p] },
      cwd: dir,
      timeoutMs: 20_000,
      env,
      keep: 'tail',
      maxChars: 50_000,
    });
    expect(r.stdout.length).toBe(50_000);
    expect(r.stdout.endsWith('LAST-LINE-MARKER')).toBe(true);
    expect(r.truncatedStdout).toBe(true);
  });

  it('plafond par défaut = DEFAULT_MAX_OUTPUT_CHARS', async () => {
    const p = await script('big-default.js', "process.stdout.write('B'.repeat(150000))");
    const r = await runShellCommand({
      target: { file: node, args: [p] },
      cwd: dir,
      timeoutMs: 20_000,
      env,
    });
    expect(r.stdout.length).toBe(DEFAULT_MAX_OUTPUT_CHARS);
    expect(r.truncatedStdout).toBe(true);
  });

  it('multi-octets à cheval sur deux chunks : aucun U+FFFD', async () => {
    // 200 000 « 日 » = 600 000 octets sur TROIS octets chacun : les chunks du
    // tuyau font 65 536 octets, qui n'est pas un multiple de 3, donc une
    // frontière tombe forcément au milieu d'un caractère. (Avec « é » sur deux
    // octets, 65 536 étant pair, les frontières s'alignaient par hasard et la
    // mutation « chunk.toString() » passait — vérifié le 03/09.) Le
    // StringDecoder par flux recolle ; toString() par morceau rend des « � ».
    const p = await script('utf8.js', "process.stdout.write('\\u65e5'.repeat(200000))");
    const r = await runShellCommand({
      target: { file: node, args: [p] },
      cwd: dir,
      timeoutMs: 20_000,
      env,
      maxChars: 500_000,
    });
    expect(r.outcome).toEqual({ kind: 'exit', exitCode: 0 });
    expect(r.stdout.length).toBe(200_000);
    expect(r.stdout.includes('\uFFFD')).toBe(false);
    expect(r.stdout).toBe('\u65E5'.repeat(200_000));
  });
});
