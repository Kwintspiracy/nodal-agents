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
} from './xlsx';
export { docxReadTool, docxCreateTool, docxAppendParagraphsTool } from './docx';
export { pptxReadTool, pptxCreateTool } from './pptx';

import {
  xlsxReadTool,
  xlsxSetCellTool,
  xlsxSetRangeTool,
  xlsxAppendRowsTool,
  xlsxAddSheetTool,
  xlsxCreateTool,
  xlsxDeleteRowsTool,
} from './xlsx';
import { docxReadTool, docxCreateTool, docxAppendParagraphsTool } from './docx';
import { pptxReadTool, pptxCreateTool } from './pptx';
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
  docxReadTool,
  docxCreateTool,
  docxAppendParagraphsTool,
  pptxReadTool,
  pptxCreateTool,
];
