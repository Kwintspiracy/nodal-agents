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
import type { ToolDefinition } from '../../types';
import type { z } from 'zod';

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
];
