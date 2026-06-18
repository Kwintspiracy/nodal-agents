import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSkillScriptTool } from '../builtin/run-skill-script.ts';
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
});

afterAll(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

describe('run_skill_script', () => {
  it('executes a bundled script and returns its real stdout + exit code; args pass verbatim (no shell injection)', async () => {
    const out = await runSkillScriptTool.execute(
      // The third arg contains shell metacharacters — with shell:false they must
      // arrive at the script literally, proving the no-injection guarantee.
      { skill: SLUG, script: 'scripts/echo.js', args: ['--prompt', 'a cat', '; rm -rf /'] },
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
        { skill: SLUG, script: 'scripts/echo.js' },
        ctx({ scriptAuthorizedSkillSlugs: [] }),
      ),
    ).rejects.toThrow(/scripts_not_authorized/);
  });

  it('refuses a path that escapes the skill folder (path_escape)', async () => {
    await expect(
      runSkillScriptTool.execute({ skill: SLUG, script: '../../package.json' }, ctx()),
    ).rejects.toThrow(/outside the skill folder|escape|resolve/i);
  });

  it('refuses an unsupported script type', async () => {
    await expect(
      runSkillScriptTool.execute({ skill: SLUG, script: 'data.txt' }, ctx()),
    ).rejects.toThrow(/unsupported_script_type/);
  });

  it('refuses a skill the agent does not hold, even if it was marked authorized', async () => {
    // Authorization passes (slug in scriptAuthorizedSkillSlugs) but the agent
    // does not actually hold the skill → resolveSkillRoot rejects. Defense in depth.
    await expect(
      runSkillScriptTool.execute(
        { skill: SLUG, script: 'scripts/echo.js' },
        ctx({ assignedSkillSlugs: [] }),
      ),
    ).rejects.toThrow(/not assigned/i);
  });
});
