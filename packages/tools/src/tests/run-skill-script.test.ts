import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSkillScriptTool, resolvePythonInterpreter } from '../builtin/run-skill-script.ts';
import type { ToolContext } from '../types.ts';

// Real skill store on disk: <store>/test-skill/{scripts/echo.js, data.txt}.
let storeDir: string;
const SLUG = 'test-skill';

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    jobId: 'j',
    agentId: 'a',
    entityId: 'e',
    // Builtin never touches the db — a stub is fine and keeps the test pure.
    db: {} as ToolContext['db'],
    jobChatId: null,
    skillStoreDir: storeDir,
    assignedSkillSlugs: [SLUG],
    scriptAuthorizedSkillSlugs: [SLUG],
    ...over,
  };
}

beforeAll(async () => {
  storeDir = await mkdtemp(join(tmpdir(), 'skillstore-'));
  const skillDir = join(storeDir, SLUG);
  await mkdir(join(skillDir, 'scripts'), { recursive: true });
  // echo.js prints the args it received as JSON — lets us assert REAL execution
  // and that args reach the script verbatim (no shell interpretation).
  await writeFile(
    join(skillDir, 'scripts', 'echo.js'),
    'console.log(JSON.stringify(process.argv.slice(2)));\n',
  );
  await writeFile(join(skillDir, 'data.txt'), 'hello');
  // write-bundle.js pollutes the bundle: writes a file next to the scripts
  // (cwd = the skill folder), like a generation script defaulting to ./outputs.
  await writeFile(
    join(skillDir, 'scripts', 'write-bundle.js'),
    "require('node:fs').mkdirSync('outputs', { recursive: true });\n" +
      "require('node:fs').writeFileSync('outputs/fake.png', 'png');\n",
  );
  // write-shared.js does it right: writes into $NODAL_SHARED_WORKSPACE.
  await writeFile(
    join(skillDir, 'scripts', 'write-shared.js'),
    'const p = process.env.NODAL_SHARED_WORKSPACE;\n' +
      "if (!p) { console.error('no NODAL_SHARED_WORKSPACE'); process.exit(1); }\n" +
      "require('node:fs').writeFileSync(require('node:path').join(p, 'artifact.png'), 'png');\n" +
      'console.log(p);\n',
  );
});

afterAll(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

describe('run_skill_script', () => {
  it('executes a bundled script and returns its real stdout + exit code; args pass verbatim (no shell injection)', async () => {
    const out = await runSkillScriptTool.execute(
      // The third arg contains shell metacharacters — with shell:false they must
      // arrive at the script literally, proving the no-injection guarantee.
      {
        purpose: 'run a bundled script',
        skill: SLUG,
        script: 'scripts/echo.js',
        args: ['--prompt', 'a cat', '; rm -rf /'],
      },
      ctx(),
    );
    expect(out.exitCode).toBe(0);
    expect(out.interpreter).toBe('node');
    expect(out.timedOut).toBe(false);
    expect(JSON.parse(out.stdout.trim())).toEqual(['--prompt', 'a cat', '; rm -rf /']);
  });

  it('refuses execution when the owner has NOT authorized scripts for this agent × skill', async () => {
    await expect(
      runSkillScriptTool.execute(
        { purpose: 'run a bundled script', skill: SLUG, script: 'scripts/echo.js' },
        ctx({ scriptAuthorizedSkillSlugs: [] }),
      ),
    ).rejects.toThrow(/scripts_not_authorized/);
  });

  it('refuses a path that escapes the skill folder (path_escape)', async () => {
    await expect(
      runSkillScriptTool.execute(
        { purpose: 'run a bundled script', skill: SLUG, script: '../../package.json' },
        ctx(),
      ),
    ).rejects.toThrow(/outside the skill folder|escape|resolve/i);
  });

  it('refuses an unsupported script type', async () => {
    await expect(
      runSkillScriptTool.execute(
        { purpose: 'run a bundled script', skill: SLUG, script: 'data.txt' },
        ctx(),
      ),
    ).rejects.toThrow(/unsupported_script_type/);
  });

  it('detects and reports files a script writes into the bundle (bundle_pollution)', async () => {
    const out = await runSkillScriptTool.execute(
      {
        purpose: 'script that pollutes its bundle',
        skill: SLUG,
        script: 'scripts/write-bundle.js',
      },
      ctx(),
    );
    expect(out.exitCode).toBe(0);
    expect(out.bundleWrites).toEqual(['outputs/fake.png']);
    expect(out.warning).toMatch(/bundle_pollution/);
    expect(out.warning).toMatch(/shared workspace/i);
    // Clean up so later tests see a pristine bundle.
    await rm(join(storeDir, SLUG, 'outputs'), { recursive: true, force: true });
  });

  it('exposes the shared workspace to the script via NODAL_SHARED_WORKSPACE — writes land there, no warning', async () => {
    const sharedDir = await mkdtemp(join(tmpdir(), 'shared-ws-'));
    try {
      const out = await runSkillScriptTool.execute(
        {
          purpose: 'script writing to the shared workspace',
          skill: SLUG,
          script: 'scripts/write-shared.js',
        },
        ctx({ workspaces: [{ label: 'shared', path: sharedDir }] }),
      );
      expect(out.exitCode).toBe(0);
      // The script SAW the real path and the artifact REALLY landed in shared.
      expect(out.stdout.trim()).toBe(sharedDir);
      expect(await readFile(join(sharedDir, 'artifact.png'), 'utf8')).toBe('png');
      // Nothing new in the bundle → no pollution report.
      expect(out.bundleWrites).toBeUndefined();
      expect(out.warning).toBeUndefined();
      expect(await readdir(join(storeDir, SLUG))).not.toContain('artifact.png');
    } finally {
      await rm(sharedDir, { recursive: true, force: true });
    }
  });

  // Live incident 2026-07-20: on Windows, bare `python` resolved to the
  // Microsoft Store STUB (exit 9009 "Python was not found") and every .py
  // skill script died. The tool now probes py/python/python3 and uses the
  // first that actually answers `--version` — asserted here by REALLY running
  // a Python script end-to-end. Skipped only when the machine has no Python.
  it.skipIf(resolvePythonInterpreter() === null)(
    'runs a real .py script with the probed interpreter (no Store-stub 9009)',
    async () => {
      await writeFile(
        join(storeDir, SLUG, 'scripts', 'hello.py'),
        "import sys\nprint('py-ok', sys.argv[1])\n",
      );
      const out = await runSkillScriptTool.execute(
        {
          purpose: 'run a bundled python script',
          skill: SLUG,
          script: 'scripts/hello.py',
          args: ['42'],
        },
        ctx(),
      );
      expect(out.exitCode).toBe(0);
      expect(out.stdout.trim()).toBe('py-ok 42');
    },
  );

  it('refuses a skill the agent does not hold, even if it was marked authorized', async () => {
    // Authorization passes (slug in scriptAuthorizedSkillSlugs) but the agent
    // does not actually hold the skill → resolveSkillRoot rejects. Defense in depth.
    await expect(
      runSkillScriptTool.execute(
        { purpose: 'run a bundled script', skill: SLUG, script: 'scripts/echo.js' },
        ctx({ assignedSkillSlugs: [] }),
      ),
    ).rejects.toThrow(/not assigned/i);
  });
});
