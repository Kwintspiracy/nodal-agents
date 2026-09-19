// constat-wiring.test.ts — LE SEAM RANGE LE CONSTAT, et il range le bon.
//
// Issue #199. `git-constat.test.ts` prouve le delta lui-même, sur un dépôt
// temporaire. Ce fichier-ci prouve l'autre moitié : que le VRAI `executeTool`
// le calcule au bon moment et l'écrit dans `constated_writes`, avec le mot qui
// dit d'où il vient.
//
// Ce qui se joue, et qu'aucun compte d'appels ne montrerait : un `run_command`
// qui écrit un fichier SANS LE NOMMER. Depuis #102 il ne créditait plus rien —
// le `cwd` d'un shell ne se lit pas — et le fichier qu'il venait d'écrire
// n'apparaissait nulle part. Les assertions portent donc sur les LIGNES
// relues en base : le chemin, le genre, et `constated_by`.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, constatedWrites, eq } from '@nodal-agents/db';
import { normalizePath } from '@nodal-agents/shared';
import { createToolRegistry } from '../registry';
import { registerBuiltins } from '../builtin';
import { executeTool } from '../execute';
import type { ApprovalRule, ExecuteOptions, ToolContext } from '../types';

const run = promisify(execFile);

const registry = createToolRegistry();
registerBuiltins(registry);

/** L'outil du registre, par son nom — jamais une définition recopiée ici. */
function outil(nom: string) {
  const t = registry.get(nom);
  if (!t) throw new Error(`outil absent du registre : ${nom}`);
  return t;
}

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let racine = '';

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  racine = await mkdtemp(join(tmpdir(), 'nodal-constat-wiring-'));
});

afterEach(async () => {
  try {
    await rm(racine, { recursive: true, force: true });
  } catch {
    /* jetable */
  }
});

/** Un dossier de travail qui EST un dépôt, avec un premier commit. */
async function depotNeuf(nom: string): Promise<string> {
  const ws = join(racine, nom);
  await mkdir(ws, { recursive: true });
  await writeFile(join(ws, 'package.json'), '{}');
  await writeFile(join(ws, '.gitignore'), 'node_modules/\n');
  await writeFile(join(ws, 'depart.ts'), 'export const d = 1;\n');
  const git = (args: string[]) => run('git', args, { cwd: ws, windowsHide: true });
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await git(['config', 'user.name', 'Test']);
  await git(['add', '.']);
  await git(['commit', '-m', 'depart']);
  return ws;
}

/** Le même dossier, SANS dépôt — la règle de #196 s'y applique encore. */
async function dossierNeuf(nom: string): Promise<string> {
  const ws = join(racine, nom);
  await mkdir(ws, { recursive: true });
  await writeFile(join(ws, 'package.json'), '{}');
  return ws;
}

async function jobNeuf(): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'constat wiring',
    })
    .returning();
  if (!job) throw new Error('job insert failed');
  return job.id;
}

function ctx(ws: string, jobId: string): ToolContext {
  return {
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId,
    jobChatId: null,
    workspaces: [{ label: 'shared', path: ws }],
    turn: 1,
  } as unknown as ToolContext;
}

function autoApprove(): ExecuteOptions {
  const rules: ApprovalRule[] = registry
    .list()
    .filter((t) => t.mutatesWorkspace === true)
    .map((t) => ({
      id: `rule-${t.name}`,
      toolName: t.name,
      action: 'auto_approve',
      agentId: seed.agentId,
      entityId: seed.entityId,
    })) as ApprovalRule[];
  return { approvalRules: rules, onApprovalRequired: async () => {} };
}

/** Les lignes rangées pour ce job, telles quelles. */
async function lignes(jobId: string) {
  const rows = await db
    .select({
      path: constatedWrites.path,
      changeKind: constatedWrites.changeKind,
      constatedBy: constatedWrites.constatedBy,
    })
    .from(constatedWrites)
    .where(eq(constatedWrites.jobId, jobId));
  return rows
    .map((r) => ({
      nom: r.path.slice(r.path.lastIndexOf('/') + 1),
      kind: r.changeKind,
      par: r.constatedBy,
    }))
    .sort((a, b) => a.nom.localeCompare(b.nom));
}

/** Une commande qui écrit sans jamais nommer son fichier à Nodal. */
function ecrire(chemin: string, contenu: string): string {
  return `node -e "require('fs').writeFileSync('${normalizePath(chemin)}', '${contenu}')"`;
}

describe('le seam range le constat @cap:travailler-sur-des-fichiers/moteur', () => {
  it('un run_command qui écrit SANS NOMMER est constaté par git', async () => {
    const ws = await depotNeuf('depot');
    const jobId = await jobNeuf();

    const res = await executeTool(
      outil('run_command'),
      { purpose: 'ecrire', command: ecrire(join(ws, 'sorti.ts'), 'export const s = 1;') },
      ctx(ws, jobId),
      autoApprove(),
    );
    expect(res.outcome).toBe('success');

    expect(await lignes(jobId)).toEqual([{ nom: 'sorti.ts', kind: 'added', par: 'git' }]);
  });

  it('une SUPPRESSION par le shell est constatée, ce qu’aucun outil ne savait dire', async () => {
    const ws = await depotNeuf('depot');
    const jobId = await jobNeuf();

    const cible = normalizePath(join(ws, 'depart.ts'));
    const res = await executeTool(
      outil('run_command'),
      { purpose: 'effacer', command: `node -e "require('fs').unlinkSync('${cible}')"` },
      ctx(ws, jobId),
      autoApprove(),
    );
    expect(res.outcome).toBe('success');

    expect(await lignes(jobId)).toEqual([{ nom: 'depart.ts', kind: 'deleted', par: 'git' }]);
  });

  it('un fichier écrit sous un chemin IGNORÉ ne devient pas un livrable', async () => {
    const ws = await depotNeuf('depot');
    const jobId = await jobNeuf();
    await mkdir(join(ws, 'node_modules'), { recursive: true });

    await executeTool(
      outil('run_command'),
      {
        purpose: 'installer',
        command: ecrire(join(ws, 'node_modules', 'x.js'), 'module.exports = 1;'),
      },
      ctx(ws, jobId),
      autoApprove(),
    );

    expect(await lignes(jobId)).toEqual([]);
  });

  it('un dossier SANS dépôt retombe sur le disque, et la ligne le DIT', async () => {
    const ws = await dossierNeuf('sans-git');
    const jobId = await jobNeuf();

    // Un shell qui écrit sans nommer : hors dépôt, rien ne le constate — c'est
    // la borne de #196, et elle est intacte.
    await executeTool(
      outil('run_command'),
      { purpose: 'ecrire', command: ecrire(join(ws, 'invisible.ts'), 'export const i = 1;') },
      ctx(ws, jobId),
      autoApprove(),
    );
    expect(await lignes(jobId)).toEqual([]);

    // Un fichier NOMMÉ, lui, reste constaté sur le disque, et sa ligne porte
    // `disk` : l'écran dira que cette liste ne promet pas ce que git promet.
    const res = await executeTool(
      outil('file_write'),
      { path: 'nomme.ts', content: 'export const n = 1;\n' },
      ctx(ws, jobId),
      autoApprove(),
    );
    expect(res.outcome).toBe('success');

    expect(await lignes(jobId)).toEqual([{ nom: 'nomme.ts', kind: 'added', par: 'disk' }]);
  });

  it('un fichier NOMMÉ dans un dépôt n’est pas compté deux fois', async () => {
    const ws = await depotNeuf('depot');
    const jobId = await jobNeuf();

    await executeTool(
      outil('file_write'),
      { path: 'ecrit.ts', content: 'export const e = 1;\n' },
      ctx(ws, jobId),
      autoApprove(),
    );
    // Puis une commande dans le même dépôt : `git status` voit encore
    // `ecrit.ts`, mais son empreinte n'a pas bougé depuis l'état d'avant la
    // commande — elle ne rentre pas une seconde fois.
    await executeTool(
      outil('run_command'),
      { purpose: 'rien', command: 'node -e "1"' },
      ctx(ws, jobId),
      autoApprove(),
    );

    expect(await lignes(jobId)).toEqual([{ nom: 'ecrit.ts', kind: 'added', par: 'disk' }]);
  });
});
