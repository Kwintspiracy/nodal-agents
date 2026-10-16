// sandbox-report.test.ts — le résultat de CHAQUE commande dit son régime
// (#628, invariant #4) : une commande qui tourne sans bac à sable le dit dans
// son tool_result, avec le code stable, pas seulement dans un journal. À
// travers les vrais `run_command` et `run_skill_script`, sur tous les systèmes,
// sous un bac à sable rendu indisponible.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeJobProcessScope, createSandbox, jobProcessScope } from '@nodal-agents/sandbox';
import { runCommandTool } from '../builtin/run-command';
import { runSkillScriptTool } from '../builtin/run-skill-script';
import type { ToolContext } from '../types';

const JOB = 'job-sandbox-report';
const SLUG = 'report-skill';
let ws: string;
let store: string;

function ctx(): ToolContext {
  return {
    jobId: JOB,
    agentId: 'agent-report',
    entityId: 'entity-report',
    db: undefined as unknown as ToolContext['db'],
    jobChatId: null,
    workspaces: [{ label: 'ws', path: ws }],
    skillStoreDir: store,
    assignedSkillSlugs: [SLUG],
    scriptAuthorizedSkillSlugs: [SLUG],
  };
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'nodal-sbx-report-'));
  store = await mkdtemp(join(tmpdir(), 'nodal-sbx-report-store-'));
  await mkdir(join(store, SLUG, 'scripts'), { recursive: true });
  await writeFile(join(store, SLUG, 'scripts', 'hello.js'), "console.log('hello');\n");
  // Le périmètre de ce job, ouvert sous un bac à sable SANS backend : celui
  // de macOS et de Linux aujourd'hui, ou d'un Windows dont la sonde a échoué.
  jobProcessScope(JOB, createSandbox(null, { platform: 'linux', log: () => {} }));
});

afterAll(async () => {
  await closeJobProcessScope(JOB);
  for (const d of [ws, store]) await rm(d, { recursive: true, force: true });
});

describe('a command that ran without the sandbox says so in its result @cap:executer-une-commande/moteur', () => {
  it('run_command: `sandbox` = { confined: false, code }', async () => {
    const out = await runCommandTool.execute(
      { purpose: 'report test', command: `"${process.execPath}" -e "console.log(1)"` },
      ctx(),
    );
    expect(out.exitCode).toBe(0);
    expect(out.sandbox).toEqual({ confined: false, code: 'SANDBOX_NOT_IMPLEMENTED' });
  });

  it('run_skill_script: `sandbox` = { confined: false, code }', async () => {
    const out = await runSkillScriptTool.execute(
      { purpose: 'report test', skill: SLUG, script: 'scripts/hello.js' },
      ctx(),
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('hello');
    expect(out.sandbox).toEqual({ confined: false, code: 'SANDBOX_NOT_IMPLEMENTED' });
  });
});
