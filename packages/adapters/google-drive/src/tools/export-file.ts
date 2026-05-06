// @nodalai/adapter-google-drive — drive_export_file tool

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { drive_v3 } from 'googleapis';
import { mapDriveError } from '../errors';

const CHAR_CAP = 15000;

const ExportFileInput = z.object({
  file_id: z
    .string()
    .describe('Google Drive file ID. Must be a Google Workspace file (Doc, Sheet, Slide, etc.).'),
  mime_type: z
    .string()
    .describe(
      "Target MIME type. Examples: 'text/plain', 'text/csv', 'application/pdf', 'text/html', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'.",
    ),
});

export type ExportFileOutput = {
  file_id: string;
  mime_type: string;
  content: string;
  truncated: boolean;
  byte_size: number;
};

export function createExportFileTool(
  drive: drive_v3.Drive,
): ToolDefinition<typeof ExportFileInput, ExportFileOutput> {
  return {
    name: 'drive_export_file',
    description:
      'Export a Google Workspace file (Doc, Sheet, Slide) to a different format. Common: Google Doc → text/plain or application/pdf, Google Sheet → text/csv, Google Slides → application/pdf. Use drive_read_file for regular (non-Workspace) files.',
    inputSchema: ExportFileInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const isTextMime =
          input.mime_type.startsWith('text/') || input.mime_type === 'application/json';

        if (isTextMime) {
          const res = await drive.files.export(
            { fileId: input.file_id, mimeType: input.mime_type },
            { responseType: 'text' },
          );
          const raw = typeof res.data === 'string' ? res.data : String(res.data);
          const truncated = raw.length > CHAR_CAP;
          const content = truncated
            ? raw.slice(0, CHAR_CAP) + '\n\n[...export truncated at 15000 chars...]'
            : raw;

          return {
            file_id: input.file_id,
            mime_type: input.mime_type,
            content,
            truncated,
            byte_size: Buffer.byteLength(raw, 'utf-8'),
          };
        } else {
          // Binary export (PDF, DOCX, etc.) — return byte count and note
          const res = await drive.files.export(
            { fileId: input.file_id, mimeType: input.mime_type },
            { responseType: 'arraybuffer' },
          );
          const byteSize = (res.data as ArrayBuffer).byteLength;

          return {
            file_id: input.file_id,
            mime_type: input.mime_type,
            content: `Binary export complete (${byteSize} bytes). Use a text-based MIME type (e.g. text/plain, text/csv) to get readable content.`,
            truncated: false,
            byte_size: byteSize,
          };
        }
      } catch (err) {
        throw mapDriveError(err);
      }
    },
  };
}
