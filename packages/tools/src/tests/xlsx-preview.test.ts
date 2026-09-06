// xlsx-preview.test.ts — P12 : un classeur écrit MONTRE ce qu'il contient.
//
// Rien n'est simulé : de vrais classeurs sur disque, exceljs, `executeTool`,
// et une VRAIE base. Les assertions portent sur la ligne `tool_calls` relue —
// `presented.files[0].preview` — parce que c'est cette ligne-là que l'écran
// lit, pas la valeur de retour de `execute()`. Un aperçu juste dans la sortie
// mais absent de la ligne ne montrerait rien à personne.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { desc, eq } from '@nodal-agents/db';
import { toolCalls } from '@nodal-agents/db';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { CARD_ROWS_MAX, projectKey } from '@nodal-agents/shared';
import type { CardPayloadFor } from '@nodal-agents/shared';
import { executeTool } from '../execute';
import {
  xlsxAddSheetTool,
  xlsxAppendRowsTool,
  xlsxCreateTool,
  xlsxSetRangeTool,
} from '../builtin/office-ops/xlsx';
import type { ToolContext, ToolDefinition } from '../types';
import type { z } from 'zod';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let WORKSPACE: string;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
  WORKSPACE = await mkdtemp(join(tmpdir(), 'nodal-xlsx-preview-'));
});

beforeEach(async () => {
  await rm(WORKSPACE, { recursive: true, force: true });
  await mkdir(WORKSPACE, { recursive: true });
});

function ctx(): ToolContext {
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
    workspaces: [{ label: 'ws', path: WORKSPACE }],
  };
}

const opts = { approvalRules: [], onApprovalRequired: async () => {} };

/**
 * Exécute l'outil PAR `executeTool` (donc la ligne d'audit est écrite), puis
 * relit cette ligne et rend sa charge utile. C'est le seul chemin qui prouve
 * que l'aperçu arrive jusqu'à l'écran.
 */
async function runAndReadCard(
  tool: ToolDefinition<z.ZodTypeAny, never> | unknown,
  input: unknown,
): Promise<CardPayloadFor<'files'>> {
  const result = await executeTool(
    tool as ToolDefinition<z.ZodTypeAny, unknown>,
    input,
    ctx(),
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
    .where(eq(toolCalls.jobId, seed.jobId))
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
});
