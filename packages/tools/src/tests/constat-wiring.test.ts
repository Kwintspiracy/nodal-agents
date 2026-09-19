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
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, constatedWrites, eq } from '@nodal-agents/db';
import { normalizePath } from '@nodal-agents/shared';
import { createToolRegistry } from '../registry';
import { registerBuiltins } from '../builtin';
import { executeTool } from '../execute';
import { recordConstatedWrites } from '../verification/record-constat';
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
  await writeFile(join(ws, '.gitignore'), 'node_modules/\ndist/\n');
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

  it('une commande lancée dans un SOUS-DOSSIER du projet est constatée par git', async () => {
    // Revue C de la PR #227, constat 1. Le cas le plus banal : le dépôt est à
    // la racine du projet, la commande tourne dans `src/`. Le périmètre du
    // constat est le DOSSIER DU PROJET, pas le `cwd` — sans les dossiers
    // attachés, la racine du dépôt était « au-dessus de la portée » et tout le
    // run retombait en silence sur le constat disque.
    const ws = await depotNeuf('depot');
    const jobId = await jobNeuf();
    await mkdir(join(ws, 'src'), { recursive: true });

    const res = await executeTool(
      outil('run_command'),
      {
        purpose: 'ecrire',
        cwd: 'src',
        command: ecrire(join(ws, 'src', 'sorti.ts'), 'export const s = 1;'),
      },
      ctx(ws, jobId),
      autoApprove(),
    );
    expect(res.outcome).toBe('success');

    expect(await lignes(jobId)).toEqual([{ nom: 'sorti.ts', kind: 'added', par: 'git' }]);
  });

  it('une cible NOMMÉE sous un chemin ignoré reste dans la liste', async () => {
    // Revue C de la PR #227, constat 2. Une première version écartait toute
    // ligne disque tombant sous une racine constatée par git. `dist/x.js` —
    // nommé par l'outil, invisible pour git — disparaissait donc du bloc Files
    // dès qu'un AUTRE fichier, suivi celui-là, avait bougé dans le même run.
    const ws = await depotNeuf('depot');
    const jobId = await jobNeuf();
    // Le dossier existe déjà — `file_write` ne crée pas les parents, et un
    // refus rendrait `success` avec une charge d'échec, donc aucune ligne :
    // le test serait vert pour la mauvaise raison.
    await mkdir(join(ws, 'dist'), { recursive: true });

    const ecrit = await executeTool(
      outil('file_write'),
      { path: 'dist/x.js', content: 'module.exports = 1;\n' },
      ctx(ws, jobId),
      autoApprove(),
    );
    expect(ecrit.outcome).toBe('success');
    expect(await lignes(jobId)).toEqual([{ nom: 'x.js', kind: 'added', par: 'disk' }]);
    // Puis une écriture que git VOIT, dans le même run et le même tour.
    await executeTool(
      outil('run_command'),
      { purpose: 'ecrire', command: ecrire(join(ws, 'suivi.ts'), 'export const s = 1;') },
      ctx(ws, jobId),
      autoApprove(),
    );

    // LES DEUX, chacune sous ce qui la constate.
    expect(await lignes(jobId)).toEqual([
      { nom: 'suivi.ts', kind: 'added', par: 'git' },
      { nom: 'x.js', kind: 'added', par: 'disk' },
    ]);
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

describe('une ligne par fichier @cap:travailler-sur-des-fichiers/moteur', () => {
  it('deux ORTHOGRAPHES du même fichier ne font qu’une ligne', async () => {
    // Le cas réel : dans un dépôt, un harnais rapporte ses fichiers avec la
    // graphie qu'on lui a donnée (forme courte 8.3, ou à travers une jonction)
    // pendant que git rend la forme longue et suivie. Sans résolution, le même
    // fichier entrait deux fois — une ligne `git`, une ligne `disk` — et le
    // bloc Files le montrait deux fois sous deux noms.
    const ws = await dossierNeuf('deux-noms');
    const jobId = await jobNeuf();
    await writeFile(join(ws, 'a.ts'), 'export const a = 1;\n');
    const lien = join(racine, 'alias-deux-noms');
    try {
      await symlink(ws, lien, 'junction');
    } catch (err) {
      console.warn(
        `[tests] CAS SAUTÉ — impossible de créer un lien : ${String(err)}\n` +
          '        La règle reste prouvée par `constat-chemin-reel.test.ts`.',
      );
      return;
    }

    await recordConstatedWrites({
      db,
      jobId,
      turn: 1,
      lignes: [
        { path: normalizePath(join(ws, 'a.ts')), kind: 'added', constatedBy: 'git' },
        { path: normalizePath(join(lien, 'a.ts')), kind: 'modified', constatedBy: 'disk' },
      ],
    });

    // UNE ligne, et c'est la première — celle du constat par git.
    expect(await lignes(jobId)).toEqual([{ nom: 'a.ts', kind: 'added', par: 'git' }]);
    await rm(lien, { recursive: true, force: true });
  });
});
