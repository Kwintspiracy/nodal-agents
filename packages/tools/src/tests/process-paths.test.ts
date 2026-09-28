// process-paths.test.ts — un fichier n'a qu'une adresse (#592).
//
// Les outils de fichiers adressent un fichier par `<étiquette>/<chemin>` ; un
// processus lancé par un outil résout ses chemins contre SON dossier de
// travail. Le 29/09, ComfyArtist (espaces `ComfyArtist` et `shared`) a lancé
// `comfy … --out-dir ComfyArtist/outputs` : le fichier est parti dans
// ComfyArtist\ComfyArtist\outputs, et le run a fini rouge. Rien ne disait à
// l'agent que les étiquettes ne sont pas des dossiers pour un processus.
//
// Ce qui se prouve ici, sur le texte RÉEL que le modèle lit (la description de
// l'outil, et le tool_result d'un vrai processus) : chaque outil qui lance un
// processus dit le dossier de travail absolu, quel espace il est, que les
// étiquettes n'y sont pas des dossiers, et le chemin absolu des autres espaces
// — pour un agent à un espace comme à plusieurs.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommandTool } from '../builtin/run-command';
import { runSkillScriptTool } from '../builtin/run-skill-script';
import { codeTaskTool } from '../builtin/code-task/index';
import type { ToolContext } from '../types';

let racine: string;
let comfy: string;
let shared: string;
let store: string;
const SLUG = 'paths-skill';

beforeAll(async () => {
  racine = await realpath(await mkdtemp(join(tmpdir(), 'nodal-paths-')));
  comfy = join(racine, 'ComfyArtist');
  shared = join(racine, 'shared');
  store = join(racine, 'store');
  await mkdir(comfy);
  await mkdir(shared);
  await mkdir(join(store, SLUG, 'scripts'), { recursive: true });
  await writeFile(join(store, SLUG, 'SKILL.md'), '---\nname: paths-skill\n---\n');
  await writeFile(join(store, SLUG, 'scripts', 'noop.js'), 'process.stdout.write("ok")\n');
});

afterAll(async () => {
  await rm(racine, { recursive: true, force: true }).catch(() => {});
});

function ctx(workspaces: ToolContext['workspaces']): ToolContext {
  return {
    jobId: 'job-paths',
    agentId: 'agent-paths',
    entityId: 'entity-paths',
    db: {} as ToolContext['db'],
    jobChatId: null,
    workspaces,
    skillStoreDir: store,
    assignedSkillSlugs: [SLUG],
    scriptAuthorizedSkillSlugs: [SLUG],
  };
}

const plusieurs = () => [
  { label: 'ComfyArtist', path: comfy },
  { label: 'shared', path: shared },
];
const unSeul = () => [{ label: 'ComfyArtist', path: comfy }];

describe('a process started by a tool says how it addresses files (#592) @cap:executer-une-commande/moteur', () => {
  it('the descriptions of every process-starting tool say labels are not folders for a process', () => {
    for (const outil of [runCommandTool, runSkillScriptTool, codeTaskTool]) {
      expect(outil.description, outil.name).toContain(
        'Workspace labels are NOT folders for a process',
      );
    }
  });

  it('run_command, agent with several workspaces: the result names the cwd, its workspace, and the others by absolute path', async () => {
    const out = await runCommandTool.execute(
      { purpose: 'test', command: 'node -e "process.stdout.write(process.cwd())"' },
      ctx(plusieurs()),
    );
    expect(out.exitCode).toBe(0);
    expect(out.paths).toBe(
      `This process ran in ${comfy}, the root of workspace "ComfyArtist". ` +
        'Paths in a process are relative to that folder, or absolute. ' +
        'Workspace labels are NOT folders for a process: write outputs/x, not ComfyArtist/outputs/x. ' +
        `Other workspaces, by absolute path: shared = ${shared}.`,
    );
  });

  it('run_command, agent with one workspace: the same rule, without other workspaces', async () => {
    const out = await runCommandTool.execute(
      { purpose: 'test', command: 'node -e "process.stdout.write(process.cwd())"' },
      ctx(unSeul()),
    );
    expect(out.paths).toBe(
      `This process ran in ${comfy}, the root of workspace "ComfyArtist". ` +
        'Paths in a process are relative to that folder, or absolute. ' +
        'Workspace labels are NOT folders for a process: write outputs/x, not ComfyArtist/outputs/x.',
    );
  });

  it('run_command in a sub-folder: the result says which workspace the folder is in', async () => {
    await mkdir(join(comfy, 'outputs'), { recursive: true });
    const out = await runCommandTool.execute(
      {
        purpose: 'test',
        command: 'node -e "process.stdout.write(process.cwd())"',
        cwd: 'ComfyArtist/outputs',
      },
      ctx(plusieurs()),
    );
    expect(out.paths).toContain(
      `This process ran in ${join(comfy, 'outputs')}, inside workspace "ComfyArtist".`,
    );
  });

  it('run_skill_script: the script runs in its skill folder, which is no workspace, and says so', async () => {
    const out = await runSkillScriptTool.execute(
      { purpose: 'test', skill: SLUG, script: 'scripts/noop.js' },
      ctx(plusieurs()),
    );
    expect(out.exitCode).toBe(0);
    expect(out.paths).toBe(
      `This process ran in ${await realpath(join(store, SLUG))}, the folder of skill "${SLUG}" (no workspace). ` +
        'Paths in a process are relative to that folder, or absolute. ' +
        "Workspace labels are NOT folders for a process: use a workspace's absolute path, never ComfyArtist/x. " +
        `Workspaces, by absolute path: ComfyArtist = ${comfy}, shared = ${shared}.`,
    );
  });
});
