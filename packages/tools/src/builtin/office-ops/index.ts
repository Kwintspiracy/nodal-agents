// office-ops/index.ts — barrel exporting all office tools as a single array.
// Import this array in the builtin index.ts to register every office tool
// with a single spread.

export {
  xlsxReadTool,
  xlsxSetCellTool,
  xlsxSetRangeTool,
  xlsxAppendRowsTool,
  xlsxAddSheetTool,
  xlsxCreateTool,
  xlsxDeleteRowsTool,
  xlsxFormatRangeTool,
  xlsxInsertRowsTool,
  xlsxInsertColumnsTool,
  xlsxDeleteColumnsTool,
  xlsxMergeCellsTool,
  xlsxUnmergeCellsTool,
  xlsxSetColumnWidthsTool,
  xlsxFreezePanesTool,
  xlsxFindCellsTool,
} from './xlsx';
export {
  docxReadTool,
  docxCreateTool,
  docxAppendParagraphsTool,
  docxReplaceTextTool,
} from './docx';
export { pptxReadTool, pptxCreateTool, pptxAppendSlidesTool, pptxReplaceTextTool } from './pptx';

import {
  xlsxReadTool,
  xlsxSetCellTool,
  xlsxSetRangeTool,
  xlsxAppendRowsTool,
  xlsxAddSheetTool,
  xlsxCreateTool,
  xlsxDeleteRowsTool,
  xlsxFormatRangeTool,
  xlsxInsertRowsTool,
  xlsxInsertColumnsTool,
  xlsxDeleteColumnsTool,
  xlsxMergeCellsTool,
  xlsxUnmergeCellsTool,
  xlsxSetColumnWidthsTool,
  xlsxFreezePanesTool,
  xlsxFindCellsTool,
} from './xlsx';
import {
  docxReadTool,
  docxCreateTool,
  docxAppendParagraphsTool,
  docxReplaceTextTool,
} from './docx';
import { pptxReadTool, pptxCreateTool, pptxAppendSlidesTool, pptxReplaceTextTool } from './pptx';
import type { MutationTarget, ToolContext, ToolDefinition } from '../../types';
import type { z } from 'zod';
import { resolveAndCheckPath } from '../file-ops/workspace';

/**
 * Les outils Office qui ne font que LIRE. Tous les autres écrivent un fichier
 * du workspace (par `writeWorkspaceBinary`, écriture atomique) et portent donc
 * l'intention de mutation comme file_write / file_edit.
 */
const OFFICE_READ_ONLY: ReadonlySet<string> = new Set([
  'xlsx_read',
  'docx_read',
  'pptx_read',
  'xlsx_find_cells',
]);

/**
 * LA cible d'un outil Office : le fichier `input.path`, résolu comme
 * `execute` le résoudra ensuite. Un chemin irrésolu rend une liste vide, comme
 * file_write : `execute` échouera dessus avec le message actionnable.
 *
 * Partagé par les vingt outils écrivains (revue Codex PR #46 : ils
 * contournaient le seam d'intention faute de marqueur `mutatesWorkspace`) —
 * le test d'énumération du registre vérifie que chacun le porte.
 */
export async function officeMutationTargets(
  input: unknown,
  ctx: ToolContext,
): Promise<readonly MutationTarget[]> {
  // Le hook reçoit l'input VALIDÉ par le zod de l'outil ; tous les outils
  // Office écrivains portent `path: z.string()`. Un input sans `path` n'a rien
  // à cibler — `execute` le refusera de son côté.
  const path = (input as { path?: unknown }).path;
  if (typeof path !== 'string') return [];
  try {
    return [{ kind: 'file', path: await resolveAndCheckPath(ctx, path) }];
  } catch {
    return [];
  }
}

function withMutationIntent(
  tool: ToolDefinition<z.ZodTypeAny, unknown>,
): ToolDefinition<z.ZodTypeAny, unknown> {
  if (OFFICE_READ_ONLY.has(tool.name)) return tool;
  return { ...tool, mutatesWorkspace: true, resolveMutationTargets: officeMutationTargets };
}

export const OFFICE_TOOLS: ToolDefinition<z.ZodTypeAny, unknown>[] = [
  xlsxReadTool,
  xlsxSetCellTool,
  xlsxSetRangeTool,
  xlsxAppendRowsTool,
  xlsxAddSheetTool,
  xlsxCreateTool,
  xlsxDeleteRowsTool,
  xlsxFormatRangeTool,
  xlsxInsertRowsTool,
  xlsxInsertColumnsTool,
  xlsxDeleteColumnsTool,
  xlsxMergeCellsTool,
  xlsxUnmergeCellsTool,
  xlsxSetColumnWidthsTool,
  xlsxFreezePanesTool,
  xlsxFindCellsTool,
  docxReadTool,
  docxCreateTool,
  docxAppendParagraphsTool,
  docxReplaceTextTool,
  pptxReadTool,
  pptxCreateTool,
  pptxAppendSlidesTool,
  pptxReplaceTextTool,
].map(withMutationIntent);
