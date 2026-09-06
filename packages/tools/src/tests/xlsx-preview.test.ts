// xlsx-preview.test.ts — P12 : un classeur écrit MONTRE ce qu'il contient.
//
// Rien n'est simulé : de vrais classeurs sur disque, exceljs, `executeTool`,
// et une VRAIE base. Les assertions portent sur la ligne `tool_calls` relue —
// `presented.files[0].preview` — parce que c'est cette ligne-là que l'écran
// lit, pas la valeur de retour de `execute()`. Un aperçu juste dans la sortie
// mais absent de la ligne ne montrerait rien à personne.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { and, desc, eq } from '@nodal-agents/db';
import { agentJobs, jobDeliverableVerificationState, toolCalls } from '@nodal-agents/db';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { CARD_COLS_MAX, CARD_ROWS_MAX, projectKey } from '@nodal-agents/shared';
import type { CardPayloadFor } from '@nodal-agents/shared';
import { executeTool } from '../execute';
import { OFFICE_TOOLS } from '../builtin/office-ops';
import type { ToolContext, ToolDefinition } from '../types';
import type { z } from 'zod';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
/** Un job NEUF et VIVANT par test : l'intention de mutation n'écrit rien sur un job terminal. */
let jobId: string;
let WORKSPACE: string;
/** Un dossier à part pour les LIENS vers l'espace de travail (jonction sous Windows). */
let LINKS: string;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
  WORKSPACE = await mkdtemp(join(tmpdir(), 'nodal-xlsx-preview-'));
  LINKS = await mkdtemp(join(tmpdir(), 'nodal-xlsx-preview-links-'));
});

beforeEach(async () => {
  await rm(WORKSPACE, { recursive: true, force: true });
  await mkdir(WORKSPACE, { recursive: true });
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'xlsx preview test',
    })
    .returning();
  if (!job) throw new Error('job insert failed');
  jobId = job.id;
});

afterAll(async () => {
  await rm(LINKS, { recursive: true, force: true });
  await rm(WORKSPACE, { recursive: true, force: true });
});

function ctx(workspaces: Array<{ label: string; path: string }> = []): ToolContext {
  return {
    jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
    workspaces: workspaces.length > 0 ? workspaces : [{ label: 'ws', path: WORKSPACE }],
  };
}

const opts = { approvalRules: [], onApprovalRequired: async () => {} };

/**
 * Les outils TELS QUE LE REGISTRE les porte — enveloppés de `mutatesWorkspace`
 * et du hook de cibles. Importer `xlsxCreateTool` nu depuis xlsx.ts contourne
 * le seam d'intention : aucune ligne d'état n'est écrite, et le test qui lit
 * cette ligne ne prouve rien.
 */
function officeTool(name: string): ToolDefinition<z.ZodTypeAny, unknown> {
  const tool = OFFICE_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`outil Office inconnu : ${name}`);
  return tool;
}
const xlsxCreateTool = officeTool('xlsx_create');
const xlsxSetRangeTool = officeTool('xlsx_set_range');
const xlsxAppendRowsTool = officeTool('xlsx_append_rows');
const xlsxAddSheetTool = officeTool('xlsx_add_sheet');
const xlsxSetCellTool = officeTool('xlsx_set_cell');

/**
 * Exécute l'outil PAR `executeTool` (donc la ligne d'audit est écrite), puis
 * relit cette ligne et rend sa charge utile. C'est le seul chemin qui prouve
 * que l'aperçu arrive jusqu'à l'écran.
 */
async function runAndReadCard(
  tool: ToolDefinition<z.ZodTypeAny, never> | unknown,
  input: unknown,
  workspaces: Array<{ label: string; path: string }> = [],
): Promise<CardPayloadFor<'files'>> {
  const result = await executeTool(
    tool as ToolDefinition<z.ZodTypeAny, unknown>,
    input,
    ctx(workspaces),
    opts,
  );
  expect(result.outcome, JSON.stringify(result)).toBe('success');
  const [row] = await db
    .select({
      presented: toolCalls.presented,
      card: toolCalls.card,
      err: toolCalls.presentationError,
    })
    .from(toolCalls)
    .where(eq(toolCalls.jobId, jobId))
    .orderBy(desc(toolCalls.createdAt), desc(toolCalls.id))
    .limit(1);
  expect(row?.err ?? null, 'la présentation a échoué').toBeNull();
  expect(row?.card).toBe('files');
  const presented = row?.presented as CardPayloadFor<'files'> | null;
  expect(presented?.card).toBe('files');
  return presented as CardPayloadFor<'files'>;
}

describe('P12 — la carte d’un classeur écrit porte l’aperçu de la feuille touchée', () => {
  it('xlsx_create puis xlsx_set_range : la ligne d’audit porte les VALEURS écrites', async () => {
    const created = await runAndReadCard(xlsxCreateTool, { path: 'report.xlsx', sheet: 'Data' });
    // Une feuille neuve est vide, et l'aperçu le dit — il n'invente pas de ligne.
    expect(created.files[0]?.preview?.rows).toEqual([]);
    expect(created.files[0]?.preview?.total).toBe(0);
    expect(created.files[0]?.preview?.name).toBe('Data');
    expect(created.files[0]?.action).toBe('created');
    expect(created.files[0]?.deliverableKey).toBe(projectKey(join(WORKSPACE, 'report.xlsx')));

    const card = await runAndReadCard(xlsxSetRangeTool, {
      path: 'report.xlsx',
      sheet: 'Data',
      start_cell: 'A1',
      values: [
        ['Name', 'Score'],
        ['Alice', 90],
        ['Bob', 75],
      ],
    });
    const preview = card.files[0]?.preview;
    expect(preview?.name).toBe('Data');
    expect(preview?.rows).toEqual([
      ['Name', 'Score'],
      ['Alice', 90],
      ['Bob', 75],
    ]);
    expect(preview?.total).toBe(3);
    expect(preview?.truncated).toBe(false);
    // Personne ne sait si la première ligne est un en-tête (P1) : la carte le dit.
    expect(preview?.header).toBe('unknown');
    expect(preview?.columns).toEqual([]);
    // Le détail ne répète pas l'aperçu — il se dessine, il ne s'épelle pas.
    expect(card.files[0]?.detail ?? '').not.toContain('preview');
    // La clé du livrable est celle de la table d'état de vérification.
    expect(card.files[0]?.deliverableKey).toBe(projectKey(join(WORKSPACE, 'report.xlsx')));
  });

  it('une FORMULE fraîchement écrite se montre comme formule — exceljs ne calcule pas', async () => {
    await runAndReadCard(xlsxCreateTool, { path: 'f.xlsx', sheet: 'S' });
    const card = await runAndReadCard(xlsxSetRangeTool, {
      path: 'f.xlsx',
      sheet: 'S',
      start_cell: 'A1',
      values: [[10], [32], ['=SUM(A1:A2)']],
    });
    // Épinglé : la lib n'évalue rien, donc la cellule n'a AUCUN résultat en
    // cache. Montrer une cellule vide ferait croire à une case blanche.
    expect(card.files[0]?.preview?.rows).toEqual([[10], [32], ['=SUM(A1:A2)']]);
  });

  it('un résultat de formule DÉJÀ en cache se montre comme la valeur qu’il est', async () => {
    // Un classeur tel qu'Excel l'écrit : la formule porte son résultat.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = 10;
    ws.getCell('A2').value = 32;
    ws.getCell('A3').value = { formula: 'SUM(A1:A2)', result: 42 };
    await wb.xlsx.writeFile(join(WORKSPACE, 'cached.xlsx'));

    const card = await runAndReadCard(xlsxAppendRowsTool, {
      path: 'cached.xlsx',
      sheet: 'S',
      rows: [['tail']],
    });
    expect(card.files[0]?.preview?.rows).toEqual([[10], [32], [42], ['tail']]);
  });

  it('une feuille de 300 lignes : l’aperçu en montre CARD_ROWS_MAX et dit le reste', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Big');
    for (let i = 1; i <= 300; i++) ws.getCell(`A${i}`).value = i;
    await wb.xlsx.writeFile(join(WORKSPACE, 'big.xlsx'));

    const card = await runAndReadCard(xlsxAppendRowsTool, {
      path: 'big.xlsx',
      sheet: 'Big',
      rows: [[301]],
    });
    const preview = card.files[0]?.preview;
    expect(preview?.rows).toHaveLength(CARD_ROWS_MAX);
    expect(preview?.total).toBe(301);
    expect(preview?.truncated).toBe(true);
    // Les lignes montrées sont les PREMIÈRES, dans l'ordre de la feuille.
    expect(preview?.rows[0]).toEqual([1]);
    expect(preview?.rows[CARD_ROWS_MAX - 1]).toEqual([CARD_ROWS_MAX]);
  });

  it('xlsx_add_sheet : la feuille neuve est vide, et l’aperçu le dit', async () => {
    await runAndReadCard(xlsxCreateTool, { path: 'a.xlsx', sheet: 'First' });
    const card = await runAndReadCard(xlsxAddSheetTool, { path: 'a.xlsx', name: 'Second' });
    expect(card.files[0]?.preview?.name).toBe('Second');
    expect(card.files[0]?.preview?.rows).toEqual([]);
    expect(card.files[0]?.preview?.total).toBe(0);
  });

  // ── Revue Codex PR #46, passe 46 ────────────────────────────────────────────

  it('racine attachée par un LIEN : la clé de la carte est celle que l’INTENTION a écrite, pas celle du chemin réel', async () => {
    // Le cas : l'espace de travail est attaché par une jonction (Windows) ou
    // un lien symbolique. L'outil résout le chemin RÉEL ; l'intention range
    // l'état du document sous le chemin LEXICAL (le lien). La carte doit
    // porter la seconde clé, sinon l'écran cherche une ligne que personne n'a
    // écrite et ne dit jamais rien de la vérification.
    const link = join(LINKS, 'ws-link');
    await symlink(WORKSPACE, link, process.platform === 'win32' ? 'junction' : 'dir');
    const viaLien = [{ label: 'ws', path: link }];

    await runAndReadCard(xlsxCreateTool, { path: 'lie.xlsx', sheet: 'S' }, viaLien);
    const card = await runAndReadCard(
      xlsxSetRangeTool,
      { path: 'lie.xlsx', sheet: 'S', start_cell: 'A1', values: [['v']] },
      viaLien,
    );
    const key = card.files[0]?.deliverableKey;
    expect(key).toBe(projectKey(join(link, 'lie.xlsx')));
    // Les deux clés diffèrent bien ici — sinon ce test ne prouverait rien.
    expect(key).not.toBe(projectKey(join(realpathSync.native(WORKSPACE), 'lie.xlsx')));

    // LA preuve : cette clé retrouve la ligne d'état que l'intention de CE job
    // a ouverte pour ce document — et c'est la seule ligne du job.
    const rows = await db
      .select({ canonicalKey: jobDeliverableVerificationState.canonicalKey })
      .from(jobDeliverableVerificationState)
      .where(
        and(
          eq(jobDeliverableVerificationState.jobId, jobId),
          eq(jobDeliverableVerificationState.deliverableType, 'office_file'),
        ),
      );
    expect(rows.map((r) => r.canonicalKey)).toEqual([key]);
  });

  it('texte riche, hyperlien, formule PARTAGÉE, erreur, date : chaque cellule se lit — jamais « [object Object] »', async () => {
    // Un classeur tel qu'Excel ou une autre lib peut l'écrire, avec toutes les
    // formes de valeur qu'exceljs sait rendre. L'outil y écrit une cellule,
    // et l'aperçu doit montrer le reste tel qu'un humain le lirait.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = { richText: [{ text: 'Total' }, { text: ' TTC' }] };
    ws.getCell('A2').value = { text: 'Nodal', hyperlink: 'https://nodal.example' };
    ws.getCell('A3').value = {
      text: { richText: [{ text: 'Site' }] },
      hyperlink: 'https://nodal.example/site',
    } as unknown as ExcelJS.CellValue;
    ws.getCell('A4').value = { error: '#N/A' } as ExcelJS.CellErrorValue;
    // Formule PARTAGÉE avec résultats : le maître porte la formule, les
    // esclaves ne portent que `sharedFormula` — exceljs la traduit à la lecture.
    ws.fillFormula('B1:B3', 'ROW()*2', [2, 4, 6]);
    ws.getCell('C1').value = { formula: '1/0', result: { error: '#DIV/0!' } };
    ws.getCell('D1').value = new Date(Date.UTC(2026, 8, 7));
    ws.getCell('D1').numFmt = 'yyyy-mm-dd';
    // Formule partagée SANS résultat : montrée comme formule, traduite par cellule.
    ws.fillFormula('E1:E2', 'A1');
    await wb.xlsx.writeFile(join(WORKSPACE, 'riche.xlsx'));

    const card = await runAndReadCard(xlsxSetCellTool, {
      path: 'riche.xlsx',
      sheet: 'S',
      cell: 'F1',
      value: 'x',
    });
    const rows = card.files[0]?.preview?.rows ?? [];
    expect(rows[0]?.[0]).toBe('Total TTC');
    expect(rows[1]?.[0]).toBe('Nodal');
    expect(rows[2]?.[0]).toBe('Site');
    expect(rows[3]?.[0]).toBe('#N/A');
    expect([rows[0]?.[1], rows[1]?.[1], rows[2]?.[1]]).toEqual([2, 4, 6]);
    expect(rows[0]?.[2]).toBe('#DIV/0!');
    expect(rows[0]?.[3]).toBe('2026-09-07');
    expect(rows[0]?.[4]).toBe('=A1');
    expect(rows[1]?.[4]).toBe('=A2');
    expect(rows[0]?.[5]).toBe('x');
    expect(JSON.stringify(card)).not.toContain('[object Object]');
  });

  it('une plage FUSIONNÉE : la valeur paraît une fois, à la cellule maître — jamais répétée sur la plage', async () => {
    // Revue passe 47 : exceljs rend la valeur du maître depuis chaque cellule
    // couverte, et « Q1 » fusionné sur A1:C2 paraissait six fois — six valeurs
    // là où le classeur n'en tient qu'une.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('M');
    ws.getCell('A1').value = 'Q1';
    ws.mergeCells('A1:C2');
    ws.getCell('A3').value = 'sous';
    await wb.xlsx.writeFile(join(WORKSPACE, 'fusion.xlsx'));

    const card = await runAndReadCard(xlsxSetCellTool, {
      path: 'fusion.xlsx',
      sheet: 'M',
      cell: 'D1',
      value: 'x',
    });
    const rows = card.files[0]?.preview?.rows ?? [];
    expect(rows[0]).toEqual(['Q1', null, null, 'x']);
    expect(rows[1]).toEqual([null, null, null]);
    expect(rows[2]).toEqual(['sous']);
    expect(JSON.stringify(rows).match(/Q1/g)).toHaveLength(1);
  });

  it('une feuille de 35 colonnes : l’aperçu en montre CARD_COLS_MAX et dit la largeur réelle', async () => {
    const WIDTH = CARD_COLS_MAX + 15;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Wide');
    for (let r = 1; r <= 3; r++) {
      for (let c = 1; c <= WIDTH; c++) ws.getCell(r, c).value = r * 100 + c;
    }
    await wb.xlsx.writeFile(join(WORKSPACE, 'wide.xlsx'));

    const card = await runAndReadCard(xlsxAppendRowsTool, {
      path: 'wide.xlsx',
      sheet: 'Wide',
      rows: [['tail']],
    });
    const preview = card.files[0]?.preview;
    expect(preview?.rows).toHaveLength(4);
    for (const row of preview?.rows.slice(0, 3) ?? []) expect(row).toHaveLength(CARD_COLS_MAX);
    // Les PREMIÈRES colonnes, dans l'ordre de la feuille.
    expect(preview?.rows[0]?.[0]).toBe(101);
    expect(preview?.rows[0]?.[CARD_COLS_MAX - 1]).toBe(100 + CARD_COLS_MAX);
    expect(preview?.columnsTotal).toBe(WIDTH);
    // Les lignes, elles, sont toutes là : la troncature de largeur ne se
    // déguise pas en troncature de hauteur.
    expect(preview?.total).toBe(4);
    expect(preview?.truncated).toBe(false);
  });
});
