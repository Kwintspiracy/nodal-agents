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
// l'outil, et le tool_result d'un vrai processus), en chaînes EXACTES : chaque
// outil qui lance un processus dit le dossier de travail absolu, quel espace
// il est, comment un chemin des outils de fichiers s'y écrit — juste pour CE
// dossier —, et le chemin absolu des autres espaces ; pour un agent sans
// espace, à un espace, à plusieurs, et à espaces imbriqués ou joints.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, realpath, symlink, writeFile } from 'node:fs/promises';
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

/** The rule the three descriptions carry, word for word. */
const REGLE =
  'Workspace labels are NOT folders for a process: the file tools address a file as ' +
  '"<label>/<path>", but a process resolves its paths against its own working directory, ' +
  "or takes absolute paths. The result's `paths` says where the process ran and what a " +
  'file-tool path is called there; reach another workspace by its absolute path (also in `paths`).';

const ECHO_CWD = 'node -e "process.stdout.write(process.cwd())"';

describe('a process started by a tool says how it addresses files (#592) @cap:executer-une-commande/moteur', () => {
  it('the descriptions of every process-starting tool carry the rule, word for word', () => {
    for (const outil of [runCommandTool, runSkillScriptTool, codeTaskTool]) {
      expect(outil.description.endsWith(REGLE), outil.name).toBe(true);
    }
  });

  it('run_command, several workspaces, at the root: the exact text', async () => {
    const out = await runCommandTool.execute(
      { purpose: 'test', command: ECHO_CWD },
      ctx(plusieurs()),
    );
    expect(out.exitCode).toBe(0);
    expect(out.paths).toBe(
      `This process ran in ${comfy}, the root of workspace "ComfyArtist". ` +
        'Paths in a process are relative to that folder, or absolute. ' +
        'Workspace labels are NOT folders for a process: what the file tools call ComfyArtist/outputs/x is outputs/x here. ' +
        `Other workspaces, by absolute path: shared = ${shared}.`,
    );
  });

  it('run_command, one workspace, at the root: the same rule, without other workspaces', async () => {
    const out = await runCommandTool.execute({ purpose: 'test', command: ECHO_CWD }, ctx(unSeul()));
    expect(out.paths).toBe(
      `This process ran in ${comfy}, the root of workspace "ComfyArtist". ` +
        'Paths in a process are relative to that folder, or absolute. ' +
        'Workspace labels are NOT folders for a process: what the file tools call ComfyArtist/outputs/x is outputs/x here.',
    );
  });

  // Revue Reviewer A de #593 (P2) : depuis un sous-dossier, « write outputs/x »
  // recréait le fantôme un niveau plus bas. L'exemple est juste pour le cwd RÉEL.
  it('run_command in a sub-folder: the example is right for THAT folder', async () => {
    await mkdir(join(comfy, 'outputs'), { recursive: true });
    const out = await runCommandTool.execute(
      { purpose: 'test', command: ECHO_CWD, cwd: 'ComfyArtist/outputs' },
      ctx(plusieurs()),
    );
    expect(out.paths).toBe(
      `This process ran in ${join(comfy, 'outputs')}, inside workspace "ComfyArtist". ` +
        'Paths in a process are relative to that folder, or absolute. ' +
        'Workspace labels are NOT folders for a process: what the file tools call ComfyArtist/outputs/x is x here. ' +
        `Other workspaces, by absolute path: shared = ${shared}.`,
    );
  });

  // Revue Reviewer A de #593 (P2) : le cwd est CANONIQUE, le chemin configuré
  // d'un espace ne l'est pas forcément (jonction, symlink, subst, 8.3, casse).
  // Les deux sont comparés dans le même espace de chemins.
  it('a workspace configured through a junction: its root is still recognised', async () => {
    const lien = join(racine, 'lien-comfy');
    await symlink(comfy, lien, 'junction');
    const out = await runCommandTool.execute(
      { purpose: 'test', command: ECHO_CWD },
      ctx([
        { label: 'ComfyArtist', path: lien },
        { label: 'shared', path: shared },
      ]),
    );
    expect(out.exitCode).toBe(0);
    expect(out.paths).toBe(
      `This process ran in ${out.cwd}, the root of workspace "ComfyArtist". ` +
        'Paths in a process are relative to that folder, or absolute. ' +
        'Workspace labels are NOT folders for a process: what the file tools call ComfyArtist/outputs/x is outputs/x here. ' +
        `Other workspaces, by absolute path: shared = ${shared}.`,
    );
  });

  // Revue Reviewer A de #593 (P3) : des espaces imbriqués — le conteneur le
  // plus PROFOND est celui où l'on est.
  it('nested workspaces: the deepest one that contains the cwd is named', async () => {
    const dedans = join(comfy, 'models');
    await mkdir(dedans, { recursive: true });
    const out = await runCommandTool.execute(
      { purpose: 'test', command: ECHO_CWD, cwd: 'models' },
      ctx([
        { label: 'ComfyArtist', path: comfy },
        { label: 'models', path: dedans },
      ]),
    );
    expect(out.paths).toBe(
      `This process ran in ${dedans}, the root of workspace "models". ` +
        'Paths in a process are relative to that folder, or absolute. ' +
        'Workspace labels are NOT folders for a process: what the file tools call models/outputs/x is outputs/x here. ' +
        `Other workspaces, by absolute path: ComfyArtist = ${comfy}.`,
    );
  });

  it('run_skill_script, skill folder in no workspace: the exact text', async () => {
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

  it('run_skill_script, skill folder INSIDE a workspace: says which one', async () => {
    const magasin = join(comfy, 'skills');
    await mkdir(join(magasin, SLUG, 'scripts'), { recursive: true });
    await writeFile(join(magasin, SLUG, 'SKILL.md'), '---\nname: paths-skill\n---\n');
    await writeFile(join(magasin, SLUG, 'scripts', 'noop.js'), 'process.stdout.write("ok")\n');
    const out = await runSkillScriptTool.execute(
      { purpose: 'test', skill: SLUG, script: 'scripts/noop.js' },
      { ...ctx(plusieurs()), skillStoreDir: magasin },
    );
    expect(out.exitCode).toBe(0);
    expect(out.paths).toBe(
      `This process ran in ${await realpath(join(magasin, SLUG))}, inside workspace "ComfyArtist". ` +
        'Paths in a process are relative to that folder, or absolute. ' +
        `Workspace labels are NOT folders for a process: what the file tools call ComfyArtist/skills/${SLUG}/x is x here. ` +
        `Other workspaces, by absolute path: shared = ${shared}.`,
    );
  });

  it('run_skill_script, agent with no workspace: only where it ran', async () => {
    const out = await runSkillScriptTool.execute(
      { purpose: 'test', skill: SLUG, script: 'scripts/noop.js' },
      ctx([]),
    );
    expect(out.exitCode).toBe(0);
    expect(out.paths).toBe(
      `This process ran in ${await realpath(join(store, SLUG))}, the folder of skill "${SLUG}" (no workspace). ` +
        'Paths in a process are relative to that folder, or absolute.',
    );
  });
});
