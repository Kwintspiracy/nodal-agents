// file-move.test.ts — déplacer ou copier un fichier dans les dossiers de
// l'agent (issue #879), par le VRAI `executeTool` : la porte d'approbation, le
// seam qui photographie et constate, et l'outil.
//
// Les assertions portent sur le disque (octets relus), sur les lignes de
// constat relues en base, et sur le texte que l'agent reçoit — jamais sur un
// compte d'appels.
//
// Trois pannes du système ne se provoquent pas sur une machine de test : un
// renommage ou un lien entre deux volumes (EXDEV), un volume sans liens
// physiques (FAT32, exFAT : EPERM) et un fichier tenu par un autre programme
// (EBUSY sous Windows). `node:fs/promises` est donc doublé ici, et seulement
// pour le chemin que le test désigne : tout le reste — le seam, les fichiers
// temporaires, les autres tests — passe par le vrai module.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const panne = vi.hoisted(() => ({
  /** `rename(source, …)` lève ce code quand `source` est ce chemin. */
  renameFrom: null as string | null,
  renameCode: 'EXDEV',
  /**
   * `link(source, …)` lève `code` pour la première règle dont `from` est
   * `source`, ou `'*'` (tout lien : un volume sans liens physiques).
   */
  link: [] as { from: string; code: string }[],
  /** `unlink(chemin)` lève EBUSY quand `chemin` est celui-ci. */
  unlinkOf: null as string | null,
  /**
   * Un AUTRE fichier qui arrive à ce chemin à l'instant exact où l'outil y pose
   * le sien (juste avant le `link`, le `rename` ou la création exclusive qui
   * le visent) : la fenêtre qu'une vérification suivie d'un renommage laisse
   * ouverte, rendue déterministe. Une seule fois.
   */
  arrive: null as { path: string; content: string } | null,
  /** Les pannes réellement levées : un faux qui ne se déclenche pas ne prouve rien. */
  levees: [] as string[],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const { resolve } = await import('node:path');
  const meme = (a: unknown, b: string | null): boolean =>
    b !== null && typeof a === 'string' && resolve(a).toLowerCase() === resolve(b).toLowerCase();
  const leve = (code: string): never => {
    panne.levees.push(code);
    throw Object.assign(new Error(`${code}: simulated`), { code });
  };
  const arrive = async (to: unknown): Promise<void> => {
    const a = panne.arrive;
    if (a === null || !meme(to, a.path)) return;
    panne.arrive = null;
    panne.levees.push('arrivée');
    await actual.writeFile(a.path, a.content);
  };
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (meme(from, panne.renameFrom)) return leve(panne.renameCode);
      await arrive(to);
      return actual.rename(from, to);
    },
    link: async (from: string, to: string) => {
      const regle = panne.link.find((r) => r.from === '*' || meme(from, r.from));
      if (regle) return leve(regle.code);
      await arrive(to);
      return actual.link(from, to);
    },
    open: async (path: string, flags?: string, mode?: number) => {
      if (flags === 'wx') await arrive(path);
      return actual.open(path, flags, mode);
    },
    unlink: async (path: string) =>
      meme(path, panne.unlinkOf) ? leve('EBUSY') : actual.unlink(path),
  };
});

import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, approvalRequests, constatedWrites, eq } from '@nodal-agents/db';
import { cheminConstate } from '../../verification/record-constat';
import { executeTool } from '../../execute';
import { presentToolResult } from '../../cards';
import { SHARED_WORKSPACE_LABEL } from './workspace';
import { fileMoveTool, type FileMoveOutput } from './file-move';
import { fileWriteTool } from './file-write';
import type { ExecuteOptions, ToolContext } from '../../types';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let racine: string;
let DOCS: string;
let ARCHIVE: string;
let SHARED: string;

/** Un PDF n'est pas du texte : des octets nuls, hauts, et un saut de ligne seul. */
const OCTETS = Buffer.from([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0xfe, 0x0a, 0x80, 0x7f, 0x0d,
]);

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  racine = await mkdtemp(join(tmpdir(), 'nodal-file-move-'));
  DOCS = join(racine, 'docs');
  ARCHIVE = join(racine, 'archive');
  SHARED = join(racine, 'shared');
  for (const d of [DOCS, ARCHIVE, SHARED]) await mkdir(d, { recursive: true });
});

afterEach(async () => {
  panne.renameFrom = null;
  panne.renameCode = 'EXDEV';
  panne.link = [];
  panne.unlinkOf = null;
  panne.arrive = null;
  panne.levees = [];
  await rm(racine, { recursive: true, force: true }).catch(() => undefined);
});

async function jobNeuf(): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({ entityId: seed.entityId, agentId: seed.agentId, channel: 'api', task: '#879' })
    .returning();
  if (!job) throw new Error('job insert failed');
  return job.id;
}

function ctx(jobId: string = seed.jobId): ToolContext {
  return {
    jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
    turn: 1,
    workspaces: [
      { label: 'docs', path: DOCS },
      { label: 'archive', path: ARCHIVE },
      { label: SHARED_WORKSPACE_LABEL, path: SHARED },
    ],
  };
}

const sansRegle: ExecuteOptions = { approvalRules: [], onApprovalRequired: async () => {} };

/** Un appel par le vrai seam, et ce que l'outil a rendu. */
async function deplacer(
  input: Record<string, unknown>,
  c: ToolContext = ctx(),
): Promise<FileMoveOutput> {
  const res = await executeTool(fileMoveTool, input as never, c, sansRegle);
  if (res.outcome !== 'success') {
    throw new Error(`appel non abouti : ${res.outcome} ${JSON.stringify(res)}`);
  }
  return res.output as FileMoveOutput;
}

const existe = async (p: string): Promise<boolean> => (await stat(p).catch(() => null)) !== null;

describe('file_move — déplacer et copier @cap:travailler-sur-des-fichiers/moteur', () => {
  it('déplace un fichier binaire d’un dossier à l’autre, sans que ses octets passent par le résultat', async () => {
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    const [reelDocs, reelArchive] = [await realpath(DOCS), await realpath(ARCHIVE)];

    const out = await deplacer({
      source: 'docs/scan.pdf',
      destination: 'archive/2026/scan.pdf',
      create_dirs: true,
    });

    expect(out).toEqual({
      ok: true,
      operation: 'moved',
      source: join(reelDocs, 'scan.pdf'),
      destination: join(reelArchive, '2026', 'scan.pdf'),
      bytes: OCTETS.length,
    });
    expect(await readFile(join(ARCHIVE, '2026', 'scan.pdf'))).toEqual(OCTETS);
    expect(await existe(join(DOCS, 'scan.pdf'))).toBe(false);
    // Le résultat que le modèle lit : deux chemins et une taille, jamais le contenu.
    const serialise = JSON.stringify(out);
    expect(serialise).not.toContain(OCTETS.toString('base64'));
    expect(serialise).not.toContain(OCTETS.toString('latin1'));
  });

  it('copie : la source reste, la destination porte les mêmes octets', async () => {
    await writeFile(join(DOCS, 'export.xlsx'), OCTETS);

    const out = await deplacer({
      source: 'docs/export.xlsx',
      destination: 'archive/export.xlsx',
      copy: true,
    });

    expect(out.ok && out.operation).toBe('copied');
    expect(await readFile(join(DOCS, 'export.xlsx'))).toEqual(OCTETS);
    expect(await readFile(join(ARCHIVE, 'export.xlsx'))).toEqual(OCTETS);
  });

  it('un dossier existant comme destination garde le nom du fichier', async () => {
    await writeFile(join(DOCS, 'facture.pdf'), OCTETS);
    await deplacer({ source: 'docs/facture.pdf', destination: 'archive' });
    expect(await readFile(join(ARCHIVE, 'facture.pdf'))).toEqual(OCTETS);
  });

  it('une destination finie par « / » est un dossier : créé avec create_dirs, refusé sans', async () => {
    await writeFile(join(DOCS, 'a.pdf'), OCTETS);
    const refus = await deplacer({ source: 'docs/a.pdf', destination: 'archive/recus/' });
    expect(refus).toEqual({
      ok: false,
      reason:
        'Parent directory does not exist for "archive/recus/". Pass create_dirs:true to create it.',
    });
    expect(await existe(join(DOCS, 'a.pdf'))).toBe(true);

    await deplacer({ source: 'docs/a.pdf', destination: 'archive/recus/', create_dirs: true });
    expect(await readFile(join(ARCHIVE, 'recus', 'a.pdf'))).toEqual(OCTETS);
  });

  it('avec replace:true, un fichier existant dans un dossier de l’agent est remplacé, sans approbation', async () => {
    await writeFile(join(DOCS, 'v2.pdf'), OCTETS);
    await writeFile(join(ARCHIVE, 'rapport.pdf'), 'v1');
    const out = await deplacer({
      source: 'docs/v2.pdf',
      destination: 'archive/rapport.pdf',
      replace: true,
    });
    expect(out.ok && out.operation).toBe('moved');
    expect(await readFile(join(ARCHIVE, 'rapport.pdf'))).toEqual(OCTETS);
    expect(await existe(join(DOCS, 'v2.pdf'))).toBe(false);
  });

  it('avec replace:true, une copie remplace aussi, et la source reste', async () => {
    await writeFile(join(DOCS, 'v2.pdf'), OCTETS);
    await writeFile(join(ARCHIVE, 'rapport.pdf'), 'v1');
    const out = await deplacer({
      source: 'docs/v2.pdf',
      destination: 'archive/rapport.pdf',
      copy: true,
      replace: true,
    });
    expect(out.ok && out.operation).toBe('copied');
    expect(await readFile(join(ARCHIVE, 'rapport.pdf'))).toEqual(OCTETS);
    expect(await readFile(join(DOCS, 'v2.pdf'))).toEqual(OCTETS);
    expect(await readdir(ARCHIVE)).toEqual(['rapport.pdf']);
  });

  it('un dossier comme source est refusé, et la raison le dit', async () => {
    await mkdir(join(DOCS, 'lot'), { recursive: true });
    await writeFile(join(DOCS, 'lot', 'x.pdf'), OCTETS);
    const out = await deplacer({ source: 'docs/lot', destination: 'archive/lot' });
    expect(out).toEqual({
      ok: false,
      reason:
        '"docs/lot" is a folder. This tool moves or copies one file at a time: call it for each file the folder holds.',
    });
    expect(await readFile(join(DOCS, 'lot', 'x.pdf'))).toEqual(OCTETS);
    expect(await readdir(ARCHIVE)).toEqual([]);
  });

  it('une source absente, ou identique à la destination, est refusée', async () => {
    expect(await deplacer({ source: 'docs/rien.pdf', destination: 'archive/' })).toEqual({
      ok: false,
      reason: 'File not found: "docs/rien.pdf".',
    });
    await writeFile(join(DOCS, 'meme.pdf'), OCTETS);
    expect(await deplacer({ source: 'docs/meme.pdf', destination: 'docs/' })).toEqual({
      ok: false,
      reason: 'Source and destination are the same file: "docs/meme.pdf". Nothing to do.',
    });
    expect(await readFile(join(DOCS, 'meme.pdf'))).toEqual(OCTETS);
  });
});

describe('file_move — le périmètre est celui de file_write, des deux côtés @cap:travailler-sur-des-fichiers/moteur', () => {
  it('une source hors des dossiers de l’agent est refusée, et rien ne bouge', async () => {
    const dehors = join(racine, 'dehors');
    await mkdir(dehors, { recursive: true });
    await writeFile(join(dehors, 'secret.pdf'), OCTETS);
    const out = await deplacer({ source: join(dehors, 'secret.pdf'), destination: 'docs/' });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toContain('does not reside in any configured workspace');
    expect(await readFile(join(dehors, 'secret.pdf'))).toEqual(OCTETS);
    expect(await readdir(DOCS)).toEqual([]);
  });

  it('une destination hors des dossiers de l’agent est refusée, et la source reste', async () => {
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    const dehors = join(racine, 'dehors');
    await mkdir(dehors, { recursive: true });
    const out = await deplacer({ source: 'docs/scan.pdf', destination: join(dehors, 'scan.pdf') });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toContain('does not reside in any configured workspace');
    expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
    expect(await existe(join(dehors, 'scan.pdf'))).toBe(false);
  });

  it('un lien qui sort du dossier ne sert pas de destination', async () => {
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    const dehors = join(racine, 'dehors');
    await mkdir(dehors, { recursive: true });
    // Une jonction sous Windows (sans privilège), un lien de dossier ailleurs.
    await symlink(dehors, join(ARCHIVE, 'sortie'), 'junction');
    const out = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/sortie/scan.pdf' });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toContain('outside the workspace');
    expect(await existe(join(dehors, 'scan.pdf'))).toBe(false);
    expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
  });

  it('un modèle de workflow partagé ne s’emporte pas, mais se copie', async () => {
    await mkdir(join(SHARED, 'workflows'), { recursive: true });
    await writeFile(join(SHARED, 'workflows', 'modele.json'), '{"a":1}');
    const emporte = await deplacer({
      source: 'shared/workflows/modele.json',
      destination: 'docs/',
    });
    expect(emporte.ok).toBe(false);
    expect(await existe(join(SHARED, 'workflows', 'modele.json'))).toBe(true);

    const copie = await deplacer({
      source: 'shared/workflows/modele.json',
      destination: 'docs/',
      copy: true,
    });
    expect(copie.ok).toBe(true);
    expect(await readFile(join(DOCS, 'modele.json'), 'utf8')).toBe('{"a":1}');
  });
});

describe('file_move — la porte d’écrasement de file_write, sur la destination @cap:travailler-sur-des-fichiers/moteur', () => {
  it('remplacer un fichier du dossier partagé que ce run n’a pas écrit attend une personne, et rien ne bouge', async () => {
    const jobId = await jobNeuf();
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    await writeFile(join(SHARED, 'scan.pdf'), 'le travail d’un autre');

    const res = await executeTool(
      fileMoveTool,
      {
        source: 'docs/scan.pdf',
        destination: 'shared/',
        replace: true,
        purpose: 'Ranger le scan.',
      } as never,
      ctx(jobId),
      sansRegle,
    );

    expect(res.outcome).toBe('awaiting_approval');
    expect(await readFile(join(SHARED, 'scan.pdf'), 'utf8')).toBe('le travail d’un autre');
    expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
    const demandes = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, jobId));
    expect(demandes.map((d) => d.toolName)).toEqual(['file_move']);
  });

  it('un fichier que ce run a écrit, changé entre la porte et le renommage, n’est pas remplacé', async () => {
    // La porte a dit « c'est à toi » (contenu écrit par ce job), puis quelqu'un
    // change le fichier avant le renommage : la question est reposée au plus
    // près de l'écriture, comme pour file_write (#505), et rien n'est écrasé.
    const jobId = await jobNeuf();
    const cible = join(SHARED, 'take.txt');
    const ecrit = await executeTool(
      fileWriteTool,
      { path: 'shared/take.txt', content: 'take 1' },
      ctx(jobId),
      sansRegle,
    );
    expect(ecrit.outcome).toBe('success');
    await writeFile(join(DOCS, 'take.txt'), 'take 2');
    const lent = {
      ...fileMoveTool,
      execute: async (
        input: Parameters<typeof fileMoveTool.execute>[0],
        c: Parameters<typeof fileMoveTool.execute>[1],
      ) => {
        await writeFile(cible, 'edited meanwhile', 'utf8');
        return fileMoveTool.execute(input, c);
      },
    } as typeof fileMoveTool;

    const res = await executeTool(
      lent,
      { source: 'docs/take.txt', destination: 'shared/take.txt', replace: true } as never,
      ctx(jobId),
      sansRegle,
    );

    expect(res.outcome).toBe('success');
    const out = (res as { output: FileMoveOutput }).output;
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toContain('changed since this call was allowed');
    expect(await readFile(cible, 'utf8')).toBe('edited meanwhile');
    expect(await readFile(join(DOCS, 'take.txt'), 'utf8')).toBe('take 2');
  });

  it('retirer du dossier partagé un fichier que ce run n’a pas écrit attend une personne, et rien ne bouge', async () => {
    // Retirer le travail d'un autre le détruit autant que l'écraser : la même
    // porte, la même question, sur la SOURCE d'un déplacement.
    const jobId = await jobNeuf();
    await writeFile(join(SHARED, 'brief.pdf'), OCTETS);

    const res = await executeTool(
      fileMoveTool,
      { source: 'shared/brief.pdf', destination: 'docs/', purpose: 'Ranger le brief.' } as never,
      ctx(jobId),
      sansRegle,
    );

    expect(res.outcome).toBe('awaiting_approval');
    expect(await readFile(join(SHARED, 'brief.pdf'))).toEqual(OCTETS);
    expect(await existe(join(DOCS, 'brief.pdf'))).toBe(false);
  });

  it('COPIER depuis le dossier partagé le fichier d’un autre ne demande rien : la source reste', async () => {
    await writeFile(join(SHARED, 'brief.pdf'), OCTETS);
    const out = await deplacer({ source: 'shared/brief.pdf', destination: 'docs/', copy: true });
    expect(out.ok).toBe(true);
    expect(await readFile(join(SHARED, 'brief.pdf'))).toEqual(OCTETS);
    expect(await readFile(join(DOCS, 'brief.pdf'))).toEqual(OCTETS);
  });

  it('retirer du dossier partagé un fichier que CE run a écrit ne demande rien', async () => {
    const jobId = await jobNeuf();
    const ecrit = await executeTool(
      fileWriteTool,
      { path: 'shared/notes.md', content: 'mes notes' },
      ctx(jobId),
      sansRegle,
    );
    expect(ecrit.outcome).toBe('success');

    const out = await deplacer({ source: 'shared/notes.md', destination: 'docs/' }, ctx(jobId));

    expect(out.ok).toBe(true);
    expect(await readFile(join(DOCS, 'notes.md'), 'utf8')).toBe('mes notes');
    expect(await existe(join(SHARED, 'notes.md'))).toBe(false);
  });

  it('une source partagée changée entre la porte et le renommage n’est pas retirée', async () => {
    const jobId = await jobNeuf();
    const source = join(SHARED, 'take.md');
    await executeTool(
      fileWriteTool,
      { path: 'shared/take.md', content: 'take 1' },
      ctx(jobId),
      sansRegle,
    );
    const lent = {
      ...fileMoveTool,
      execute: async (
        input: Parameters<typeof fileMoveTool.execute>[0],
        c: Parameters<typeof fileMoveTool.execute>[1],
      ) => {
        await writeFile(source, 'edited meanwhile', 'utf8');
        return fileMoveTool.execute(input, c);
      },
    } as typeof fileMoveTool;

    const res = await executeTool(
      lent,
      { source: 'shared/take.md', destination: 'docs/' } as never,
      ctx(jobId),
      sansRegle,
    );

    const out = (res as { output: FileMoveOutput }).output;
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toContain('changed since this call was allowed');
    expect(await readFile(source, 'utf8')).toBe('edited meanwhile');
    expect(await existe(join(DOCS, 'take.md'))).toBe(false);
  });

  it('un fichier NEUF dans le dossier partagé ne demande rien', async () => {
    await writeFile(join(DOCS, 'neuf.pdf'), OCTETS);
    const out = await deplacer({ source: 'docs/neuf.pdf', destination: 'shared/' });
    expect(out.ok).toBe(true);
    expect(await readFile(join(SHARED, 'neuf.pdf'))).toEqual(OCTETS);
  });
});

describe('file_move — le constat range la destination créée et la source retirée @cap:travailler-sur-des-fichiers/moteur', () => {
  it('un déplacement : une ligne « added » pour la destination, une ligne « deleted » pour la source', async () => {
    const jobId = await jobNeuf();
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    await deplacer({ source: 'docs/scan.pdf', destination: 'archive/' }, ctx(jobId));

    const lignes = await db.select().from(constatedWrites).where(eq(constatedWrites.jobId, jobId));
    expect(
      lignes
        .map((l) => ({ path: l.path, kind: l.changeKind, by: l.constatedBy }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    ).toEqual(
      [
        { path: await cheminConstate(join(ARCHIVE, 'scan.pdf')), kind: 'added', by: 'disk' },
        { path: await cheminConstate(join(DOCS, 'scan.pdf')), kind: 'deleted', by: 'disk' },
      ].sort((a, b) => a.path.localeCompare(b.path)),
    );
  });

  it('une copie : la seule destination est constatée, la source n’a pas bougé', async () => {
    const jobId = await jobNeuf();
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    await deplacer({ source: 'docs/scan.pdf', destination: 'archive/', copy: true }, ctx(jobId));

    const lignes = await db.select().from(constatedWrites).where(eq(constatedWrites.jobId, jobId));
    expect(lignes.map((l) => ({ path: l.path, kind: l.changeKind }))).toEqual([
      { path: await cheminConstate(join(ARCHIVE, 'scan.pdf')), kind: 'added' },
    ]);
  });
});

describe('file_move — entre deux volumes, et un fichier tenu par un autre programme @cap:travailler-sur-des-fichiers/moteur', () => {
  // Le faux vise le chemin RÉEL de la source, celui que l'outil renomme après
  // `resolveAndCheckPath`. Sous Windows, `tmpdir()` peut rendre la forme
  // courte 8.3 (`C:\Users\RUNNER~1\…`) et le chemin réel la forme longue :
  // viser `join(DOCS, …)` laissait le faux muet sur la CI Windows, et le
  // renommage réel passait (constat de la CI Windows de #881).
  const sourceReelle = async (): Promise<string> => realpath(join(DOCS, 'scan.pdf'));

  it('un lien entre deux volumes (EXDEV) se fait en copie puis suppression, avec la date de la source', async () => {
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    const date = new Date('2026-03-31T10:00:00Z');
    await utimes(join(DOCS, 'scan.pdf'), date, date);
    panne.link = [{ from: await sourceReelle(), code: 'EXDEV' }];

    const out = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/' });

    expect(panne.levees).toEqual(['EXDEV']);
    expect(out.ok && out.operation).toBe('moved');
    expect(await readFile(join(ARCHIVE, 'scan.pdf'))).toEqual(OCTETS);
    expect((await stat(join(ARCHIVE, 'scan.pdf'))).mtime.toISOString()).toBe(date.toISOString());
    expect(await existe(join(DOCS, 'scan.pdf'))).toBe(false);
    // Aucun fichier temporaire laissé derrière la copie.
    expect(await readdir(ARCHIVE)).toEqual(['scan.pdf']);
  });

  it('avec replace:true, un renommage entre deux volumes (EXDEV) se fait en copie puis suppression', async () => {
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    await writeFile(join(ARCHIVE, 'scan.pdf'), 'v1');
    panne.renameFrom = await sourceReelle();

    const out = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/', replace: true });

    expect(panne.levees).toEqual(['EXDEV']);
    expect(out.ok && out.operation).toBe('moved');
    expect(await readFile(join(ARCHIVE, 'scan.pdf'))).toEqual(OCTETS);
    expect(await existe(join(DOCS, 'scan.pdf'))).toBe(false);
    expect(await readdir(ARCHIVE)).toEqual(['scan.pdf']);
  });

  it('avec replace:true, une suppression ratée après la copie est DITE : les deux fichiers existent', async () => {
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    panne.renameFrom = await sourceReelle();
    panne.unlinkOf = await sourceReelle();

    const out = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/', replace: true });

    expect(panne.levees).toEqual(['EXDEV', 'EBUSY']);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toMatch(
      /^"docs\/scan\.pdf" was copied to ".*scan\.pdf", but the original could not be removed \(EBUSY: EBUSY: simulated\)\. Both files exist now\.$/,
    );
    expect(await readFile(join(ARCHIVE, 'scan.pdf'))).toEqual(OCTETS);
    expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
  });

  // Sans replace, un déplacement qui ne peut pas retirer sa source retire ce
  // qu'il a posé : rien n'a bougé, et la raison le dit — sur le même volume
  // (un lien) comme entre deux volumes (une copie).
  for (const cas of [
    { nom: 'sur le même volume', link: [] as { from: string; code: string }[], levees: ['EBUSY'] },
    {
      nom: 'entre deux volumes',
      link: [{ from: 'source', code: 'EXDEV' }],
      levees: ['EXDEV', 'EBUSY'],
    },
  ]) {
    it(`une source qui ne se retire pas (EBUSY) ${cas.nom} : rien ne bouge, et la raison le dit`, async () => {
      await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
      const src = await sourceReelle();
      panne.link = cas.link.map((r) => ({ ...r, from: src }));
      panne.unlinkOf = src;

      const out = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/' });

      expect(panne.levees).toEqual(cas.levees);
      expect(out).toEqual({
        ok: false,
        reason:
          'Could not move "docs/scan.pdf" to "archive/" (EBUSY: EBUSY: simulated). The file may be ' +
          'open in another program, still being written, or read-only. Call again once it is ' +
          'complete and closed.',
      });
      expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
      expect(await readdir(ARCHIVE)).toEqual([]);
    });
  }

  for (const cas of [
    { nom: 'sans replace (le lien)', replace: false },
    { nom: 'avec replace:true (le renommage)', replace: true },
  ]) {
    it(`un fichier encore ouvert ailleurs (EBUSY) ${cas.nom} échoue avec sa raison, et rien ne bouge`, async () => {
      await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
      if (cas.replace) {
        panne.renameFrom = await sourceReelle();
        panne.renameCode = 'EBUSY';
      } else {
        panne.link = [{ from: await sourceReelle(), code: 'EBUSY' }];
      }

      const out = await deplacer({
        source: 'docs/scan.pdf',
        destination: 'archive/',
        replace: cas.replace,
      });

      expect(panne.levees).toEqual(['EBUSY']);
      expect(out).toEqual({
        ok: false,
        reason:
          'Could not move "docs/scan.pdf" to "archive/" (EBUSY: EBUSY: simulated). The file may be ' +
          'open in another program, still being written, or read-only. Call again once it is ' +
          'complete and closed.',
      });
      expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
      expect(await readdir(ARCHIVE)).toEqual([]);
    });
  }
});

describe('file_move — la carte du fil dit « moved A to B » @cap:travailler-sur-des-fichiers/moteur', () => {
  it('un déplacement et une copie portent leur geste et la source', () => {
    for (const operation of ['moved', 'copied'] as const) {
      const carte = presentToolResult(
        fileMoveTool as never,
        { source: 'docs/scan.pdf', destination: 'archive/' },
        {
          ok: true,
          operation,
          source: '/w/docs/scan.pdf',
          destination: '/w/archive/scan.pdf',
          bytes: 12,
        },
      );
      expect(carte).toEqual({
        card: 'files',
        files: [
          { path: '/w/archive/scan.pdf', action: operation, from: '/w/docs/scan.pdf', bytes: 12 },
        ],
        total: 1,
        truncated: false,
      });
    }
  });
});

// ─── #933 : jamais de remplacement sans `replace: true` ───────────────────────
//
// Deux jobs de rangement lancés en même temps ont posé deux documents sous le
// même nom : les deux appels ont rendu `ok: true`, et l'un des documents a
// disparu. Une liste du dossier faite avant ne protège pas un déplacement :
// c'est l'outil qui refuse, en un seul geste du système.

const DOC_A = Buffer.concat([OCTETS, Buffer.from(' document A')]);
const DOC_B = Buffer.concat([OCTETS, Buffer.from(' document B, plus long')]);

/** Le refus d'un nom pris : il nomme le fichier qui est là (chemin, taille, date). */
async function refusNomPris(
  out: FileMoveOutput,
  verbe: 'moved' | 'copied',
  chemin: string,
): Promise<void> {
  const reel = join(await realpath(dirname(chemin)), basename(chemin));
  const st = await stat(chemin);
  expect(out).toEqual({
    ok: false,
    reason:
      `Nothing was ${verbe}: "${reel}" already exists (${String(st.size)} bytes, modified ` +
      `${st.mtime.toISOString()}). file_move never replaces an existing file unless ` +
      'replace:true is passed. Choose another name, or pass replace:true if replacing this ' +
      'file is intended.',
    existing: { path: reel, bytes: st.size, modified: st.mtime.toISOString() },
  });
}

/** Aucun fichier temporaire ni réservation laissés dans le dossier. */
async function seulement(dossier: string, noms: string[]): Promise<void> {
  expect((await readdir(dossier)).sort()).toEqual([...noms].sort());
}

/**
 * Deux appels EN MÊME TEMPS, de deux jobs, vers le même nom du dossier
 * partagé : exactement un réussit, l'autre échoue en nommant le fichier là, et
 * les deux documents existent encore — l'un à destination, l'autre à sa source.
 */
async function course(copy: boolean): Promise<void> {
  await writeFile(join(DOCS, 'a.pdf'), DOC_A);
  await writeFile(join(ARCHIVE, 'b.pdf'), DOC_B);
  const [jobA, jobB] = [await jobNeuf(), await jobNeuf()];

  const [outA, outB] = await Promise.all([
    deplacer(
      { source: 'docs/a.pdf', destination: 'shared/2026-03-31 Document.pdf', copy },
      ctx(jobA),
    ),
    deplacer(
      { source: 'archive/b.pdf', destination: 'shared/2026-03-31 Document.pdf', copy },
      ctx(jobB),
    ),
  ]);

  const reussis = [outA, outB].filter((o) => o.ok);
  expect(reussis).toHaveLength(1);
  const gagnantA = outA.ok;
  const cible = join(SHARED, '2026-03-31 Document.pdf');
  expect(await readFile(cible)).toEqual(gagnantA ? DOC_A : DOC_B);
  await refusNomPris(gagnantA ? outB : outA, copy ? 'copied' : 'moved', cible);
  // Le perdant est intact, à sa source.
  if (gagnantA) expect(await readFile(join(ARCHIVE, 'b.pdf'))).toEqual(DOC_B);
  else expect(await readFile(join(DOCS, 'a.pdf'))).toEqual(DOC_A);
  // Le gagnant : déplacé, sa source est partie ; copié, elle reste.
  const sourceGagnant = gagnantA ? join(DOCS, 'a.pdf') : join(ARCHIVE, 'b.pdf');
  expect(await existe(sourceGagnant)).toBe(copy);
  await seulement(SHARED, ['2026-03-31 Document.pdf']);
}

describe('file_move — un nom pris n’est jamais remplacé sans replace:true (#933) @cap:travailler-sur-des-fichiers/moteur', () => {
  it('deux déplacements en même temps vers le même nom : un seul réussit, aucun document perdu', async () => {
    await course(false);
  });

  it('deux copies en même temps vers le même nom : une seule réussit, aucun document perdu', async () => {
    await course(true);
  });

  // La course rendue déterministe : un autre fichier arrive au nom à l'instant
  // où l'outil pose le sien. Un geste atomique le refuse ; une vérification
  // suivie d'un renommage l'écraserait.
  for (const copy of [false, true]) {
    it(`un fichier qui arrive au nom à l’instant de la pose n’est pas écrasé (${copy ? 'copie' : 'déplacement'})`, async () => {
      await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
      const cible = join(await realpath(ARCHIVE), 'scan.pdf');
      panne.arrive = { path: cible, content: 'arrivé entre-temps' };

      const out = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/', copy });

      expect(panne.levees).toEqual(['arrivée']);
      await refusNomPris(out, copy ? 'copied' : 'moved', cible);
      expect(await readFile(cible, 'utf8')).toBe('arrivé entre-temps');
      expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
      await seulement(ARCHIVE, ['scan.pdf']);
    });
  }

  it('un nom pris dans un dossier de l’agent : refusé, la destination et la source intactes', async () => {
    await writeFile(join(DOCS, 'v2.pdf'), OCTETS);
    await writeFile(join(ARCHIVE, 'rapport.pdf'), 'v1');
    const out = await deplacer({ source: 'docs/v2.pdf', destination: 'archive/rapport.pdf' });
    await refusNomPris(out, 'moved', join(ARCHIVE, 'rapport.pdf'));
    expect(await readFile(join(ARCHIVE, 'rapport.pdf'), 'utf8')).toBe('v1');
    expect(await readFile(join(DOCS, 'v2.pdf'))).toEqual(OCTETS);
    await seulement(ARCHIVE, ['rapport.pdf']);
  });

  it('une copie vers un nom pris : refusée, aucun temporaire laissé', async () => {
    await writeFile(join(DOCS, 'v2.pdf'), OCTETS);
    await writeFile(join(ARCHIVE, 'rapport.pdf'), 'v1');
    const out = await deplacer({
      source: 'docs/v2.pdf',
      destination: 'archive/rapport.pdf',
      copy: true,
    });
    await refusNomPris(out, 'copied', join(ARCHIVE, 'rapport.pdf'));
    expect(await readFile(join(ARCHIVE, 'rapport.pdf'), 'utf8')).toBe('v1');
    await seulement(ARCHIVE, ['rapport.pdf']);
  });

  it('un nom pris dans le dossier partagé : refusé tout de suite, sans demander personne', async () => {
    // La porte d'écrasement ne demande plus rien pour une destination qu'un
    // appel sans replace ne détruira jamais : une approbation suivie d'un
    // refus serait une question pour rien.
    const jobId = await jobNeuf();
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    await writeFile(join(SHARED, 'scan.pdf'), 'le travail d’un autre');

    const out = await deplacer({ source: 'docs/scan.pdf', destination: 'shared/' }, ctx(jobId));

    await refusNomPris(out, 'moved', join(SHARED, 'scan.pdf'));
    expect(await readFile(join(SHARED, 'scan.pdf'), 'utf8')).toBe('le travail d’un autre');
    expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
    const demandes = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, jobId));
    expect(demandes).toEqual([]);
  });

  it('entre deux volumes (EXDEV), un nom pris est refusé, sans temporaire laissé', async () => {
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    await writeFile(join(ARCHIVE, 'scan.pdf'), 'v1');
    panne.link = [{ from: await realpath(join(DOCS, 'scan.pdf')), code: 'EXDEV' }];

    const out = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/' });

    expect(panne.levees).toEqual(['EXDEV']);
    await refusNomPris(out, 'moved', join(ARCHIVE, 'scan.pdf'));
    expect(await readFile(join(ARCHIVE, 'scan.pdf'), 'utf8')).toBe('v1');
    expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
    await seulement(ARCHIVE, ['scan.pdf']);
  });

  it('un lien physique de la source déjà à destination est un nom pris : les deux noms restent', async () => {
    // Même fichier, deux entrées : ce n'est pas la source elle-même (un
    // renommage de casse), et la retirer ne « déplacerait » rien.
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    await link(join(DOCS, 'scan.pdf'), join(ARCHIVE, 'scan.pdf'));

    const out = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/' });

    await refusNomPris(out, 'moved', join(ARCHIVE, 'scan.pdf'));
    expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
    expect(await readFile(join(ARCHIVE, 'scan.pdf'))).toEqual(OCTETS);
  });
});

describe('file_move — un volume sans liens physiques (FAT32, exFAT) ne remplace rien non plus (#933) @cap:travailler-sur-des-fichiers/moteur', () => {
  // `link` lève EPERM pour TOUT lien : le nom se réserve par une création
  // exclusive, et le fichier complet est renommé sur la réservation.
  beforeEach(() => {
    panne.link = [{ from: '*', code: 'EPERM' }];
  });

  it('un déplacement vers un nom libre : fait, avec la date de la source, rien d’autre dans le dossier', async () => {
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    const date = new Date('2026-03-31T10:00:00Z');
    await utimes(join(DOCS, 'scan.pdf'), date, date);

    const out = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/' });

    expect(panne.levees).toEqual(['EPERM']);
    expect(out.ok && out.operation).toBe('moved');
    expect(await readFile(join(ARCHIVE, 'scan.pdf'))).toEqual(OCTETS);
    expect((await stat(join(ARCHIVE, 'scan.pdf'))).mtime.toISOString()).toBe(date.toISOString());
    expect(await existe(join(DOCS, 'scan.pdf'))).toBe(false);
    await seulement(ARCHIVE, ['scan.pdf']);
  });

  it('une copie vers un nom libre : faite, la source reste, aucun temporaire', async () => {
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    const out = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/', copy: true });
    expect(out.ok && out.operation).toBe('copied');
    expect(await readFile(join(ARCHIVE, 'scan.pdf'))).toEqual(OCTETS);
    expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
    await seulement(ARCHIVE, ['scan.pdf']);
  });

  it('un déplacement et une copie vers un nom pris : refusés, ni réservation ni temporaire laissés', async () => {
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    await writeFile(join(ARCHIVE, 'scan.pdf'), 'v1');
    for (const copy of [false, true]) {
      const out = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/', copy });
      await refusNomPris(out, copy ? 'copied' : 'moved', join(ARCHIVE, 'scan.pdf'));
    }
    expect(await readFile(join(ARCHIVE, 'scan.pdf'), 'utf8')).toBe('v1');
    expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
    await seulement(ARCHIVE, ['scan.pdf']);
  });

  it('deux déplacements en même temps vers le même nom : un seul réussit, aucun document perdu', async () => {
    await course(false);
  });

  it('un fichier qui arrive au nom à l’instant de la réservation n’est pas écrasé', async () => {
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    const cible = join(await realpath(ARCHIVE), 'scan.pdf');
    panne.arrive = { path: cible, content: 'arrivé entre-temps' };

    const out = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/' });

    expect(panne.levees).toEqual(['EPERM', 'arrivée']);
    await refusNomPris(out, 'moved', cible);
    expect(await readFile(cible, 'utf8')).toBe('arrivé entre-temps');
    expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
  });

  it('entre deux volumes ET sans liens : un nom pris est refusé, sans temporaire laissé', async () => {
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    await writeFile(join(ARCHIVE, 'scan.pdf'), 'v1');
    panne.link = [
      { from: await realpath(join(DOCS, 'scan.pdf')), code: 'EXDEV' },
      { from: '*', code: 'EPERM' },
    ];

    const out = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/' });

    expect(panne.levees).toEqual(['EXDEV', 'EPERM']);
    await refusNomPris(out, 'moved', join(ARCHIVE, 'scan.pdf'));
    expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
    await seulement(ARCHIVE, ['scan.pdf']);
  });
});

describe('file_move — un renommage qui ne change que la casse (#933) @cap:travailler-sur-des-fichiers/moteur', () => {
  // Sur un volume insensible à la casse (Windows, macOS), `Scan.pdf` EST
  // `scan.pdf` : ce n'est pas un nom pris. Sur un volume sensible à la casse
  // (Linux), c'est un autre nom, libre. Les deux finissent avec le seul
  // `Scan.pdf`, ce que le test vérifie partout ; la CI Windows le prouve sur
  // le cas qui compte.
  it('scan.pdf -> Scan.pdf : renommé, le contenu intact, un seul fichier', async () => {
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);

    const out = await deplacer({ source: 'docs/scan.pdf', destination: 'docs/Scan.pdf' });

    expect(out.ok && out.operation).toBe('moved');
    await seulement(DOCS, ['Scan.pdf']);
    expect(await readFile(join(DOCS, 'Scan.pdf'))).toEqual(OCTETS);
  });

  it('une copie sur soi-même en changeant la casse ne fait rien là où la casse ne compte pas', async () => {
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    const insensible = await existe(join(DOCS, 'SCAN.PDF'));

    const out = await deplacer({
      source: 'docs/scan.pdf',
      destination: 'docs/Scan.pdf',
      copy: true,
    });

    if (insensible) {
      expect(out).toEqual({
        ok: false,
        reason: 'Source and destination are the same file: "docs/scan.pdf". Nothing to do.',
      });
      await seulement(DOCS, ['scan.pdf']);
    } else {
      expect(out.ok && out.operation).toBe('copied');
      await seulement(DOCS, ['Scan.pdf', 'scan.pdf']);
    }
    expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
  });
});
