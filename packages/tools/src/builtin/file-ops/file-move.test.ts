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
  /** Un second chemin dont `unlink` lève EBUSY (le retour en arrière ne peut pas le retirer). */
  unlinkAussi: null as string | null,
  /**
   * Un AUTRE fichier qui arrive à ce chemin à l'instant exact où l'outil y pose
   * le sien (juste avant le `link`, le `rename` ou la création exclusive qui
   * le visent) : la fenêtre qu'une vérification suivie d'un renommage laisse
   * ouverte, rendue déterministe. Une seule fois.
   */
  arrive: null as { path: string; content: string; op?: 'rename' } | null,
  /**
   * `stat` et `lstat` rendent un numéro de fichier nul, comme un partage réseau
   * sans index de fichier (revue A de #938).
   */
  inoNul: false,
  /** L'écriture de la marque dans une réservation (`FileHandle.writeFile`) lève EIO. */
  marqueEchoue: false,
  /**
   * Quand `unlink(unlinkOf)` lève EBUSY, un programme pose d'abord un AUTRE
   * fichier à ce chemin, par-dessus ce que l'appel avait posé (un nouveau
   * fichier renommé sur le nom, comme le fait un `replace: true`) : le retour
   * en arrière qui suit doit le laisser.
   */
  ecraseAvantRetour: null as { path: string; content: string | null } | null,
  /**
   * Ce que fait `unlink(unlinkOf)` : lever EBUSY (un fichier tenu ouvert), ou
   * ENOENT après l'avoir retiré lui-même (un autre programme a supprimé la
   * source pendant l'appel).
   */
  unlinkCode: 'EBUSY' as 'EBUSY' | 'ENOENT',
  /** Après un `unlink(unlinkOf)` raté, le premier `lstat` de ce chemin lève EIO. */
  lstatEchoueApres: null as string | null,
  lstatEchoue: null as string | null,
  /** Pendant le `unlink(unlinkOf)` raté, un programme ajoute ces octets à la fin de ce chemin. */
  ajouteAvantRetour: null as { path: string; text: string } | null,
  /** Les fichiers ouverts EN LECTURE (`open` sans « wx », `readFile`) : ce que le code lit. */
  lectures: [] as string[],
  /** Après la copie de ce chemin (`copyFile`), un programme ajoute ces octets à sa fin. */
  ajouteApresCopie: null as { path: string; text: string } | null,
  /**
   * `rename(…, path)` lève `code` les `fois` premières fois : un autre
   * programme tient la cible ouverte un instant (sous Windows, elle ne se
   * remplace pas pendant ce temps).
   */
  renameVers: null as { path: string; code: string; fois: number } | null,
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
  const arrive = async (to: unknown, op?: 'rename'): Promise<void> => {
    const a = panne.arrive;
    if (a === null || !meme(to, a.path) || (a.op !== undefined && a.op !== op)) return;
    panne.arrive = null;
    panne.levees.push('arrivée');
    await actual.writeFile(a.path, a.content);
  };
  const sansNumero = <T extends { ino: number | bigint } | undefined>(st: T): T => {
    if (panne.inoNul && st !== undefined) st.ino = typeof st.ino === 'bigint' ? BigInt(0) : 0;
    return st;
  };
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => sansNumero(await actual.stat(...args)),
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (meme(args[0], panne.lstatEchoue)) {
        panne.lstatEchoue = null;
        return leve('EIO');
      }
      return sansNumero(await actual.lstat(...args));
    },
    copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
      await actual.copyFile(...args);
      const a = panne.ajouteApresCopie;
      if (a !== null && meme(args[0], a.path)) {
        panne.ajouteApresCopie = null;
        panne.levees.push('ajouté');
        await actual.appendFile(a.path, a.text);
      }
    },
    rename: async (from: string, to: string) => {
      await arrive(to, 'rename');
      if (meme(from, panne.renameFrom)) return leve(panne.renameCode);
      const vers = panne.renameVers;
      if (vers !== null && vers.fois > 0 && meme(to, vers.path)) {
        vers.fois -= 1;
        return leve(vers.code);
      }
      return actual.rename(from, to);
    },
    link: async (from: string, to: string) => {
      const regle = panne.link.find((r) => r.from === '*' || meme(from, r.from));
      if (regle) return leve(regle.code);
      await arrive(to);
      return actual.link(from, to);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      panne.lectures.push(String(args[0]));
      return actual.readFile(...args);
    },
    open: async (path: string, flags?: string, mode?: number) => {
      if (flags !== 'wx') {
        if (flags === undefined || flags === 'r') panne.lectures.push(String(path));
        return actual.open(path, flags, mode);
      }
      await arrive(path);
      const handle = await actual.open(path, flags, mode);
      if (panne.marqueEchoue) handle.writeFile = async () => leve('EIO');
      return handle;
    },
    unlink: async (path: string) => {
      if (meme(path, panne.unlinkAussi)) return leve('EBUSY');
      if (!meme(path, panne.unlinkOf)) return actual.unlink(path);
      const e = panne.ecraseAvantRetour;
      if (e !== null) {
        panne.ecraseAvantRetour = null;
        if (e.content === null) {
          panne.levees.push('retiré');
          await actual.unlink(e.path);
        } else {
          panne.levees.push('écrasé');
          const autre = `${e.path}.autre-programme`;
          await actual.writeFile(autre, e.content);
          await actual.rename(autre, e.path);
        }
      }
      const ajout = panne.ajouteAvantRetour;
      if (ajout !== null) {
        panne.ajouteAvantRetour = null;
        panne.levees.push('ajouté');
        await actual.appendFile(ajout.path, ajout.text);
      }
      panne.lstatEchoue = panne.lstatEchoueApres;
      panne.lstatEchoueApres = null;
      if (panne.unlinkCode === 'ENOENT') await actual.unlink(path);
      return leve(panne.unlinkCode);
    },
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
import {
  fileMoveTool,
  FileMoveInputSchema,
  RESERVATION_BYTES,
  type FileMoveOutput,
} from './file-move';
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
  panne.unlinkAussi = null;
  panne.arrive = null;
  panne.inoNul = false;
  panne.marqueEchoue = false;
  panne.ecraseAvantRetour = null;
  panne.unlinkCode = 'EBUSY';
  panne.lstatEchoueApres = null;
  panne.lstatEchoue = null;
  panne.ajouteApresCopie = null;
  panne.ajouteAvantRetour = null;
  panne.lectures = [];
  panne.renameVers = null;
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
      /^"docs\/scan\.pdf" was placed at ".*scan\.pdf", but the original could not be removed \(EBUSY: EBUSY: simulated\)\. The file is at both places now\.$/,
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
async function course(copy: boolean, reservation = false): Promise<void> {
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
  const perdant = gagnantA ? outB : outA;
  if (reservation) {
    // Sans liens physiques, le perdant peut trouver le nom pendant que le
    // gagnant le tient encore RÉSERVÉ : vide juste après sa création, puis sa
    // seule marque, le temps d'un renommage. Son refus nomme alors cette
    // réservation, ce qui était vrai à l'instant de l'appel. Le nom, lui,
    // était pris dans tous les cas.
    const reel = join(await realpath(SHARED), '2026-03-31 Document.pdf');
    if (perdant.ok) throw new Error('les deux appels ont réussi');
    expect(perdant.reason).toContain('file_move never replaces an existing file');
    expect(perdant.existing?.path).toBe(reel);
    const vu = perdant.existing?.bytes ?? -1;
    expect(
      vu === (gagnantA ? DOC_A : DOC_B).length || (vu >= 0 && vu <= RESERVATION_BYTES),
      `taille vue par le perdant : ${String(vu)}`,
    ).toBe(true);
  } else {
    await refusNomPris(perdant, copy ? 'copied' : 'moved', cible);
  }
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

  // Sous Windows, un fichier tenu ouvert un instant (un autre appel qui lit
  // ses attributs, un indexeur, un antivirus) ne se remplace pas : la
  // réservation est à l'appel, qui réessaie brièvement au lieu d'échouer.
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    it(`une réservation tenue ouverte un instant (${code}) : le renommage réessaie, et le déplacement se fait`, async () => {
      await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
      const cible = join(await realpath(ARCHIVE), 'scan.pdf');
      panne.renameVers = { path: cible, code, fois: 2 };

      const out = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/' });

      expect(panne.levees).toEqual(['EPERM', code, code]);
      expect(out.ok && out.operation).toBe('moved');
      expect(await readFile(cible)).toEqual(OCTETS);
      expect(await existe(join(DOCS, 'scan.pdf'))).toBe(false);
      await seulement(ARCHIVE, ['scan.pdf']);
    });
  }

  it('une réservation écrasée exprès entre deux essais n’est jamais remplacée par l’essai suivant', async () => {
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    const cible = join(await realpath(ARCHIVE), 'scan.pdf');
    panne.arrive = { path: cible, content: 'écrit exprès par-dessus', op: 'rename' };
    panne.renameVers = { path: cible, code: 'EPERM', fois: 1 };

    const out = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/' });

    expect(panne.levees).toEqual(['EPERM', 'arrivée', 'EPERM']);
    expect(out).toEqual({
      ok: false,
      reason:
        'Could not move "docs/scan.pdf" to "archive/" (EPERM: EPERM: simulated). The file may be ' +
        'open in another program, still being written, or read-only. Call again once it is ' +
        'complete and closed.',
    });
    expect(await readFile(cible, 'utf8')).toBe('écrit exprès par-dessus');
    expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
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
    await course(false, true);
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

describe('file_move — un retour en arrière reconnaît ce qu’il a posé sans numéro de fichier (revue A de #938) @cap:travailler-sur-des-fichiers/moteur', () => {
  // Un partage réseau sans index de fichier rend un numéro nul : ce que l'appel
  // a posé doit se reconnaître quand même, et se retirer quand l'appel échoue.
  beforeEach(() => {
    panne.inoNul = true;
  });

  const ouvert =
    'Could not move "docs/scan.pdf" to "archive/" (EBUSY: EBUSY: simulated). The file may be ' +
    'open in another program, still being written, or read-only. Call again once it is ' +
    'complete and closed.';

  it('sans liens physiques, un renommage raté retire la réservation : l’appel suivant passe', async () => {
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    panne.link = [{ from: '*', code: 'EPERM' }];
    panne.renameFrom = await realpath(join(DOCS, 'scan.pdf'));
    panne.renameCode = 'EBUSY';

    const rate = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/' });

    // Huit essais, la réservation portant toujours sa marque, puis l'erreur.
    expect(panne.levees).toEqual(['EPERM', ...Array<string>(8).fill('EBUSY')]);
    expect(rate).toEqual({ ok: false, reason: ouvert });
    await seulement(ARCHIVE, []);
    expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);

    // Le fichier fermé, l'agent rappelle : rien de l'outil ne lui barre le nom.
    panne.renameFrom = null;
    const reprise = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/' });
    expect(reprise.ok && reprise.operation).toBe('moved');
    expect(await readFile(join(ARCHIVE, 'scan.pdf'))).toEqual(OCTETS);
    await seulement(ARCHIVE, ['scan.pdf']);
  });

  it('une marque de réservation qui ne s’écrit pas : la réservation est retirée, et l’erreur dite', async () => {
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    panne.link = [{ from: '*', code: 'EPERM' }];
    panne.marqueEchoue = true;

    const out = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/' });

    expect(panne.levees).toEqual(['EPERM', 'EIO']);
    expect(out).toEqual({
      ok: false,
      reason: 'Could not move "docs/scan.pdf" to "archive/" (EIO: EIO: simulated).',
    });
    await seulement(ARCHIVE, []);
    expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
  });

  it('une réservation écrasée exprès entre-temps n’est pas retirée : ce fichier n’est pas celui de l’appel', async () => {
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    const cible = join(await realpath(ARCHIVE), 'scan.pdf');
    panne.link = [{ from: '*', code: 'EPERM' }];
    panne.renameFrom = await realpath(join(DOCS, 'scan.pdf'));
    panne.renameCode = 'EBUSY';
    panne.arrive = { path: cible, content: 'écrit exprès par-dessus', op: 'rename' };

    const out = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/' });

    expect(panne.levees).toEqual(['EPERM', 'arrivée', 'EBUSY']);
    expect(out).toEqual({ ok: false, reason: ouvert });
    expect(await readFile(cible, 'utf8')).toBe('écrit exprès par-dessus');
    expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
  });

  for (const cas of [
    { nom: 'sur le même volume (un lien)', exdev: false, levees: ['EBUSY'] },
    { nom: 'entre deux volumes (une copie)', exdev: true, levees: ['EXDEV', 'EBUSY'] },
  ]) {
    it(`une source qui ne se retire pas ${cas.nom} : ce qui a été posé est retiré`, async () => {
      await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
      const src = await realpath(join(DOCS, 'scan.pdf'));
      panne.link = cas.exdev ? [{ from: src, code: 'EXDEV' }] : [];
      panne.unlinkOf = src;

      const out = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/' });

      expect(panne.levees).toEqual(cas.levees);
      expect(out).toEqual({ ok: false, reason: ouvert });
      await seulement(ARCHIVE, []);
      expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
    });
  }
});

describe('file_move — un retour en arrière laisse un fichier écrit par-dessus entre-temps (revue A de #938, passe 2) @cap:travailler-sur-des-fichiers/moteur', () => {
  // La source ne se retire pas (EBUSY) ; avant le retour en arrière, un
  // programme a posé un autre fichier, aux octets différents, sur le nom que
  // l'appel venait de poser. Ce fichier n'est pas celui de l'appel : il reste,
  // la source aussi, et l'agent apprend que les deux existent.
  for (const cas of [
    { nom: 'entre deux volumes (une copie)', exdev: true, levees: ['EXDEV', 'écrasé', 'EBUSY'] },
    { nom: 'sur le même volume (un lien)', exdev: false, levees: ['écrasé', 'EBUSY'] },
  ]) {
    it(`${cas.nom} : le fichier écrit par-dessus garde ses octets, la source reste`, async () => {
      await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
      const src = await realpath(join(DOCS, 'scan.pdf'));
      const cible = join(await realpath(ARCHIVE), 'scan.pdf');
      panne.link = cas.exdev ? [{ from: src, code: 'EXDEV' }] : [];
      panne.unlinkOf = src;
      panne.ecraseAvantRetour = { path: cible, content: 'écrit par un autre programme' };

      const out = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/' });

      expect(panne.levees).toEqual(cas.levees);
      // Rien n'a été déplacé : la destination porte le fichier d'un autre, et
      // l'original, à la source, est le seul exemplaire (revue A, passe 3).
      expect(out).toEqual({
        ok: false,
        reason:
          'Nothing was moved: the original "docs/scan.pdf" could not be removed (EBUSY: EBUSY: ' +
          `simulated), and "${cible}" now holds a different file, written there by another ` +
          'program during this call. The original is still at "docs/scan.pdf": keep it.',
      });
      expect(await readFile(cible, 'utf8')).toBe('écrit par un autre programme');
      expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
      await seulement(ARCHIVE, ['scan.pdf']);
    });
  }
});

describe('file_move — un déplacement inachevé dit ce qui est sur le disque (revue A de #938, passe 3) @cap:travailler-sur-des-fichiers/moteur', () => {
  // La source ne se retire pas, et ce que l'appel a posé ne se retire pas non
  // plus : le fichier est aux deux endroits, par un lien sur le même volume
  // comme par une copie entre deux. Le texte ne dit jamais « copié » d'un lien.
  for (const cas of [
    { nom: 'sur le même volume (un lien)', exdev: false, levees: ['EBUSY', 'EBUSY'] },
    { nom: 'entre deux volumes (une copie)', exdev: true, levees: ['EXDEV', 'EBUSY', 'EBUSY'] },
  ]) {
    it(`${cas.nom} : « placé », et le fichier aux deux endroits`, async () => {
      await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
      const src = await realpath(join(DOCS, 'scan.pdf'));
      const cible = join(await realpath(ARCHIVE), 'scan.pdf');
      panne.link = cas.exdev ? [{ from: src, code: 'EXDEV' }] : [];
      panne.unlinkOf = src;
      panne.unlinkAussi = cible;

      const out = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/' });

      expect(panne.levees).toEqual(cas.levees);
      expect(out).toEqual({
        ok: false,
        reason:
          `"docs/scan.pdf" was placed at "${cible}", but the original could not be removed ` +
          '(EBUSY: EBUSY: simulated). The file is at both places now.',
      });
      expect(await readFile(cible)).toEqual(OCTETS);
      expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
    });
  }
});

describe('file_move — un déplacement inachevé se dit d’après le disque, vu une fois (revue A de #938, passe 4) @cap:travailler-sur-des-fichiers/moteur', () => {
  // Deux faits, vus une fois à la fin, sur tous les chemins (replace:true
  // compris) : la source est-elle là, et la destination porte-t-elle ce que
  // l'appel y a posé (l'empreinte prise en le posant), autre chose, ou rien.
  const AJOUT = ' -- ajouté pendant la copie';

  async function preparer(opts: { exdev: boolean; replace?: boolean }): Promise<{
    src: string;
    cible: string;
  }> {
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    const src = await realpath(join(DOCS, 'scan.pdf'));
    const cible = join(await realpath(ARCHIVE), 'scan.pdf');
    if (opts.exdev) {
      if (opts.replace === true) panne.renameFrom = src;
      else panne.link = [{ from: src, code: 'EXDEV' }];
    }
    panne.unlinkOf = src;
    return { src, cible };
  }

  const deplace = (replace = false): Promise<FileMoveOutput> =>
    deplacer({ source: 'docs/scan.pdf', destination: 'archive/', replace });

  it('replace:true entre deux volumes, la copie écrasée par un autre programme : rien n’a bougé, garder la source', async () => {
    const { cible } = await preparer({ exdev: true, replace: true });
    panne.ecraseAvantRetour = { path: cible, content: 'écrit par un autre programme' };

    const out = await deplace(true);

    expect(out).toEqual({
      ok: false,
      reason:
        'Nothing was moved: the original "docs/scan.pdf" could not be removed (EBUSY: EBUSY: ' +
        `simulated), and "${cible}" now holds a different file, written there by another ` +
        'program during this call. The original is still at "docs/scan.pdf": keep it.',
    });
    expect(await readFile(cible, 'utf8')).toBe('écrit par un autre programme');
    expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
  });

  for (const cas of [
    { nom: 'replace:true entre deux volumes', exdev: true, replace: true },
    { nom: 'entre deux volumes', exdev: true, replace: false },
    { nom: 'sur le même volume', exdev: false, replace: false },
  ]) {
    it(`${cas.nom}, la source supprimée par un autre programme : le fichier n’est plus qu’à destination`, async () => {
      const { cible } = await preparer(cas);
      panne.unlinkCode = 'ENOENT';

      const out = await deplace(cas.replace);

      expect(out).toEqual({
        ok: false,
        reason:
          `"docs/scan.pdf" was placed at "${cible}", and the original is no longer at ` +
          `"docs/scan.pdf" (ENOENT: ENOENT: simulated). The file is now only at "${cible}".`,
      });
      expect(await readFile(cible)).toEqual(OCTETS);
      expect(await existe(join(DOCS, 'scan.pdf'))).toBe(false);
    });
  }

  it('entre deux volumes, la source complétée pendant la copie : la copie de l’appel est reconnue, et retirée', async () => {
    // La destination porte la copie que l'appel a faite, pas les octets
    // ACTUELS de la source : c'est bien la sienne, et le retour en arrière la
    // retire. La source, complétée, reste : rien n'a bougé.
    const { src, cible } = await preparer({ exdev: true });
    panne.ajouteApresCopie = { path: src, text: AJOUT };

    const out = await deplace();

    expect(panne.levees).toEqual(['EXDEV', 'ajouté', 'EBUSY']);
    expect(out).toEqual({
      ok: false,
      reason:
        'Could not move "docs/scan.pdf" to "archive/" (EBUSY: EBUSY: simulated). The file may be ' +
        'open in another program, still being written, or read-only. Call again once it is ' +
        'complete and closed.',
    });
    expect(await existe(cible)).toBe(false);
    expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(
      Buffer.concat([OCTETS, Buffer.from(AJOUT)]),
    );
  });

  it('la source supprimée ET la destination écrasée : dit fort que l’original est perdu de vue', async () => {
    const { cible } = await preparer({ exdev: true });
    panne.unlinkCode = 'ENOENT';
    panne.ecraseAvantRetour = { path: cible, content: 'écrit par un autre programme' };

    const out = await deplace();

    expect(out).toEqual({
      ok: false,
      reason:
        'The original "docs/scan.pdf" is gone (ENOENT: ENOENT: simulated), and ' +
        `"${cible}" does not hold it: it now holds a different file, written there by another ` +
        'program. This call can no longer tell where the file is: tell the person before ' +
        'doing anything else.',
    });
    expect(await readFile(cible, 'utf8')).toBe('écrit par un autre programme');
    expect(await existe(join(DOCS, 'scan.pdf'))).toBe(false);
  });

  it('la source supprimée ET la destination retirée : rien nulle part, et c’est dit', async () => {
    const { cible } = await preparer({ exdev: false });
    panne.unlinkCode = 'ENOENT';
    panne.ecraseAvantRetour = { path: cible, content: null };

    const out = await deplace();

    expect(out).toEqual({
      ok: false,
      reason:
        'The original "docs/scan.pdf" is gone (ENOENT: ENOENT: simulated), and ' +
        `"${cible}" does not hold it: nothing is there. This call can no longer tell where the ` +
        'file is: tell the person before doing anything else.',
    });
    await seulement(ARCHIVE, []);
    expect(await existe(join(DOCS, 'scan.pdf'))).toBe(false);
  });

  it('la source là, la destination retirée par un autre programme : rien n’a bougé, garder la source', async () => {
    const { cible } = await preparer({ exdev: true });
    panne.ecraseAvantRetour = { path: cible, content: null };

    const out = await deplace();

    expect(out).toEqual({
      ok: false,
      reason:
        'Nothing was moved: the original "docs/scan.pdf" could not be removed (EBUSY: EBUSY: ' +
        `simulated), and nothing is at "${cible}" any more: another program removed what this ` +
        'call had placed there. The original is still at "docs/scan.pdf": keep it.',
    });
    await seulement(ARCHIVE, []);
    expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
  });

  it('une lecture qui échoue en regardant le disque est dite comme telle, et rien n’est retiré', async () => {
    const { cible } = await preparer({ exdev: true });
    panne.lstatEchoueApres = cible;

    const out = await deplace();

    expect(out).toEqual({
      ok: false,
      reason:
        'The original "docs/scan.pdf" could not be removed (EBUSY: EBUSY: simulated), and ' +
        `checking what is on disk afterwards failed: reading "${cible}" gave EIO: EIO: ` +
        `simulated. Look at "docs/scan.pdf" and "${cible}" before doing anything else.`,
    });
    expect(await readFile(cible)).toEqual(OCTETS);
    expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(OCTETS);
  });
});

describe('file_move — le chemin qui réussit ne lit aucun octet du fichier posé (arbitrage du 03/11) @cap:travailler-sur-des-fichiers/moteur', () => {
  // Un déplacement sur un même volume est un lien : O(1), quelle que soit la
  // taille du fichier. Ce que l'outil LIT pendant l'appel se compte au seam :
  // rien, sur un déplacement, une copie, un déplacement entre deux volumes ou
  // sans liens physiques. (L'appel passe par `execute` seul : le seam de
  // constat, qui photographie les fichiers, n'est pas ce que l'arbitrage vise.)
  const executer = async (input: Record<string, unknown>): Promise<FileMoveOutput> =>
    fileMoveTool.execute(FileMoveInputSchema.parse(input), ctx());

  for (const cas of [
    { nom: 'un déplacement sur le même volume', copy: false, panne: () => undefined },
    { nom: 'une copie', copy: true, panne: () => undefined },
    {
      nom: 'un déplacement entre deux volumes',
      copy: false,
      panne: async () => {
        panne.link = [{ from: await realpath(join(DOCS, 'scan.pdf')), code: 'EXDEV' }];
      },
    },
    {
      nom: 'un déplacement sans liens physiques',
      copy: false,
      panne: () => {
        panne.link = [{ from: '*', code: 'EPERM' }];
      },
    },
  ]) {
    it(`${cas.nom} : aucune lecture`, async () => {
      await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
      await cas.panne();

      const out = await executer({
        source: 'docs/scan.pdf',
        destination: 'archive/',
        copy: cas.copy,
      });

      expect(out.ok).toBe(true);
      expect(panne.lectures).toEqual([]);
      expect(await readFile(join(ARCHIVE, 'scan.pdf'))).toEqual(OCTETS);
    });
  }
});

describe('file_move — un lien sur un volume sans numéros de fichier se reconnaît à ses octets (arbitrage du 03/11) @cap:travailler-sur-des-fichiers/moteur', () => {
  // Tant que le lien tient, la source et la destination SONT le même fichier :
  // un programme qui écrit dans la source écrit aussi dans la destination. Sa
  // date change, ses octets restent ceux de la source : c'est toujours le
  // fichier de l'appel, et le retour en arrière le retire.
  it('la source complétée pendant le retrait raté : le lien est reconnu, retiré, rien n’a bougé', async () => {
    panne.inoNul = true;
    await writeFile(join(DOCS, 'scan.pdf'), OCTETS);
    const src = await realpath(join(DOCS, 'scan.pdf'));
    panne.unlinkOf = src;
    panne.ajouteAvantRetour = { path: src, text: ' -- ajouté' };

    const out = await deplacer({ source: 'docs/scan.pdf', destination: 'archive/' });

    expect(panne.levees).toEqual(['ajouté', 'EBUSY']);
    expect(out).toEqual({
      ok: false,
      reason:
        'Could not move "docs/scan.pdf" to "archive/" (EBUSY: EBUSY: simulated). The file may be ' +
        'open in another program, still being written, or read-only. Call again once it is ' +
        'complete and closed.',
    });
    await seulement(ARCHIVE, []);
    expect(await readFile(join(DOCS, 'scan.pdf'))).toEqual(
      Buffer.concat([OCTETS, Buffer.from(' -- ajouté')]),
    );
  });
});
