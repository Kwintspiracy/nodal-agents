// @nodalai/adapter-google-drive — drive_read_file tool

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { drive_v3 } from 'googleapis';
import { mapDriveError, DriveAdapterError } from '../errors';
import { extractFileText, FILE_SIZE_CAP_BYTES } from '../extractors/index';

const CHAR_CAP = 15000;

const ReadFileInput = z.object({
  file_id: z
    .string()
    .describe('The Google Drive file ID (from drive_list_files or drive_get_file_info).'),
});

export type ReadFileOutput = {
  file_id: string;
  name: string;
  mimeType: string;
  content: string;
  truncated: boolean;
  char_count: number;
};

export function createReadFileTool(
  drive: drive_v3.Drive,
): ToolDefinition<typeof ReadFileInput, ReadFileOutput> {
  return {
    name: 'drive_read_file',
    description:
      'Read the text content of a file from Google Drive. Handles Google Docs (exported as plain text), plain text, DOCX, PDF, XLSX. Use drive_list_files first to get the file ID.',
    inputSchema: ReadFileInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        // 1. Fetch metadata
        const metaRes = await drive.files.get({
          fileId: input.file_id,
          fields: 'id,name,mimeType,size',
        });
        const meta = metaRes.data;
        const mime = meta.mimeType ?? '';
        const name = meta.name ?? '';
        const sizeBytes = meta.size != null ? Number(meta.size) : null;

        // 2. Size cap check for non-Google-Workspace files
        if (sizeBytes != null && sizeBytes > FILE_SIZE_CAP_BYTES) {
          throw new DriveAdapterError(
            'drive_file_too_large',
            `File exceeds the 25 MB extraction limit (${Math.round(sizeBytes / 1024 / 1024)} MB).`,
          );
        }

        let rawContent: string;

        // 3. Google Workspace files — use export endpoint
        if (mime.startsWith('application/vnd.google-apps.')) {
          let exportMime: string;
          if (mime === 'application/vnd.google-apps.document') {
            exportMime = 'text/plain';
          } else if (mime === 'application/vnd.google-apps.spreadsheet') {
            exportMime = 'text/csv';
          } else if (mime === 'application/vnd.google-apps.presentation') {
            exportMime = 'text/plain';
          } else {
            exportMime = 'text/plain';
          }

          const exportRes = await drive.files.export(
            { fileId: input.file_id, mimeType: exportMime },
            { responseType: 'text' },
          );
          rawContent = typeof exportRes.data === 'string' ? exportRes.data : String(exportRes.data);
        } else {
          // 4. Binary/regular files — download and extract
          const dlRes = await drive.files.get(
            { fileId: input.file_id, alt: 'media' },
            { responseType: 'arraybuffer' },
          );
          const buffer = Buffer.from(dlRes.data as ArrayBuffer);
          rawContent = await extractFileText(buffer, mime, name);
        }

        const truncated = rawContent.length > CHAR_CAP;
        const content = truncated
          ? rawContent.slice(0, CHAR_CAP) + '\n\n[...file truncated at 15000 chars...]'
          : rawContent;

        return {
          file_id: input.file_id,
          name,
          mimeType: mime,
          content,
          truncated,
          char_count: content.length,
        };
      } catch (err) {
        throw mapDriveError(err);
      }
    },
  };
}
