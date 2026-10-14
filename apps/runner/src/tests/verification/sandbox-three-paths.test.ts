// sandbox-three-paths.test.ts — les TROIS chemins de l'étape 1 de #628 sont
// confinés par le même mécanisme : `run_command`, `run_skill_script`, et les
// commandes de preuve de `declare_verification` (le `runProof` que la
// finalisation appelle). Un seul test, paramétré, à travers les VRAIS
// appelants : chacun lance le même script, qui écrit dans le workspace puis
// tente d'écrire dans un canari frère. Le workspace est écrit, le canari reste
// intact — l'assertion porte sur le disque.
//
// WINDOWS SEULEMENT (backend MXC) ; macOS et Linux viennent dans les PR
// suivantes de #628. Sous Windows, un bac à sable indisponible fait échouer la
// suite avec sa raison, jamais un vert par absence.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeJobProcessScope, getSandboxStatus } from '@nodal-agents/sandbox';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import type { ToolContext } from '@nodal-agents/tools';
import { codeProjectVerifier } from '../../verification/code-project.ts';

const isWindows = process.platform === 'win32';
const SLUG = 'sandbox-skill';

// Les outils tels que le runner les reçoit : par le registre des builtins.
const registry = createToolRegistry();
registerBuiltins(registry);
const tool = (name: string) => {
  const t = registry.get(name);
  if (!t) throw new Error(`builtin missing: ${name}`);
  return t;
};

let base: string;
let ws: string;
let canary: string;
let store: string;

function ctx(): ToolContext {
  return {
    jobId: 'job-3p',
    agentId: 'agent-3p',
    entityId: 'entity-3p',
    db: undefined as unknown as ToolContext['db'],
    jobChatId: null,
    workspaces: [{ label: 'ws', path: ws }],
    skillStoreDir: store,
    assignedSkillSlugs: [SLUG],
    scriptAuthorizedSkillSlugs: [SLUG],
  };
}

/** Ce que chaque chemin rend, ramené au même constat. */
interface PathRun {
  exitCode: number | null;
  stderr: string;
}

const paths: { name: string; run: (inside: string, outside: string) => Promise<PathRun> }[] = [
  {
    name: 'run_command',
    run: async (inside, outside) => {
      const out = (await tool('run_command').execute(
        {
          purpose: 'sandbox three paths',
          command: `"${process.execPath}" "${join(store, SLUG, 'scripts', 'write-both.js')}" "${inside}" "${outside}"`,
        },
        ctx(),
      )) as PathRun;
      return { exitCode: out.exitCode, stderr: out.stderr };
    },
  },
  {
    name: 'run_skill_script',
    run: async (inside, outside) => {
      const out = (await tool('run_skill_script').execute(
        {
          purpose: 'sandbox three paths',
          skill: SLUG,
          script: 'scripts/write-both.js',
          args: [inside, outside],
        },
        ctx(),
      )) as PathRun;
      return { exitCode: out.exitCode, stderr: out.stderr };
    },
  },
  {
    name: 'proof command (declare_verification)',
    run: async (inside, outside) => {
      const proof = await codeProjectVerifier.runProof(
        {
          kind: 'ready',
          manifestHash: 'h',
          cwd: ws,
          epoch: 1,
          commands: [
            {
              command: `"${process.execPath}" "${join(store, SLUG, 'scripts', 'write-both.js')}" "${inside}" "${outside}"`,
              timeoutSeconds: 60,
            },
          ],
        },
        async () => {},
        // Ce que la finalisation passe : les dossiers du job.
        { writableRoots: [ws], jobId: 'job-3p' },
      );
      const record = proof.records[0];
      return { exitCode: record?.exitCode ?? null, stderr: record?.stderrTail ?? '' };
    },
  },
];

/**
 * Un Windows sans le palier MXC base-container (Windows Server, dont le runner
 * Windows de GitHub, ou un Windows plus ancien) : MXC n'y confine qu'en
 * réécrivant les ACL de tout le lecteur, et le bac à sable s'y dit
 * indisponible (SANDBOX_PLATFORM_UNSUPPORTED). La batterie de confinement n'a
 * alors rien à prouver ; la suite qui la remplace prouve que la commande
 * tourne et que la raison est dite. Toute AUTRE indisponibilité (Node trop
 * ancien, SDK absent) fait échouer la batterie, avec sa raison.
 */
const hereStatus = isWindows ? await getSandboxStatus() : undefined;
const tierUnsupported =
  hereStatus?.state === 'unavailable' && hereStatus.code === 'SANDBOX_PLATFORM_UNSUPPORTED';

describe.skipIf(!isWindows || tierUnsupported)(
  'sandbox — run_command, run_skill_script and proof commands go through ONE confinement @cap:executer-une-commande/moteur (Windows only: the macOS and Linux backends come in later PRs of #628 — skipped on a Windows without the MXC base-container tier, e.g. the GitHub Windows Server runner)',
  () => {
    beforeAll(async () => {
      const status = await getSandboxStatus();
      expect(status, JSON.stringify(status)).toEqual({
        state: 'available',
        backend: 'mxc-processcontainer',
      });
      base = await realpath(await mkdtemp(join(tmpdir(), 'nodal-sbx3-')));
      ws = join(base, 'ws');
      canary = join(base, 'canary');
      store = join(base, 'store');
      await mkdir(ws);
      await mkdir(canary);
      await mkdir(join(store, SLUG, 'scripts'), { recursive: true });
      await writeFile(join(canary, 'existing.txt'), 'original');
      // Écrit d'abord DEDANS (doit réussir), puis DEHORS (doit être refusé).
      await writeFile(
        join(store, SLUG, 'scripts', 'write-both.js'),
        "const fs = require('fs');\n" +
          "fs.writeFileSync(process.argv[2], 'inside');\n" +
          "fs.writeFileSync(process.argv[3], 'outside');\n",
      );
    });

    afterAll(async () => {
      await closeJobProcessScope('job-3p');
      for (let i = 0; i < 5; i++) {
        try {
          await rm(base, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    });

    it.each(paths)('$name: writes inside its workspace, never outside', async ({ name, run }) => {
      const slug = name.replace(/[^a-z]+/gi, '-');
      const inside = join(ws, `${slug}.txt`);
      const outside = join(canary, `${slug}.txt`);
      const out = await run(inside, outside);

      expect(await readdir(canary)).toEqual(['existing.txt']);
      expect(await readFile(join(canary, 'existing.txt'), 'utf8')).toBe('original');
      expect(existsSync(outside)).toBe(false);
      expect(await readFile(inside, 'utf8')).toBe('inside');
      expect(out.exitCode).not.toBe(0);
      expect(out.stderr).toMatch(/EPERM/);
    });
  },
);
