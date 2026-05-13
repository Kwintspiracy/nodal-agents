// @nodal-agents/adapter-google-drive — public API
// Single factory: createDriveTools(opts) → ToolDefinition[]

import type { ToolDefinition } from '@nodal-agents/tools';
import type { z } from 'zod';
import { createDriveClient } from './client';
import { createListFilesTool } from './tools/list-files';
import { createReadFileTool } from './tools/read-file';
import { createUploadFileTool } from './tools/upload-file';
import { createGetFileInfoTool } from './tools/get-file-info';
import { createCreateFolderTool } from './tools/create-folder';
import { createMoveFileTool } from './tools/move-file';
import { createRenameFileTool } from './tools/rename-file';
import { createCopyFileTool } from './tools/copy-file';
import { createDeleteFileTool } from './tools/delete-file';
import { createShareFileTool } from './tools/share-file';
import { createListPermissionsTool } from './tools/list-permissions';
import { createExportFileTool } from './tools/export-file';

export interface DriveAdapterOptions {
  /**
   * User's current OAuth2 access token for Google Drive.
   * Token refresh is the runner's responsibility — if the token expires,
   * tools throw DriveAdapterError({ code: 'drive_unauthorized' }).
   */
  accessToken: string;
}

/**
 * Create all 12 Google Drive tools using the provided OAuth access token.
 * Returns a flat ToolDefinition[] ready to register in a ToolRegistry.
 *
 * Tool count: 12
 * Read (5):        drive_list_files, drive_read_file, drive_get_file_info,
 *                  drive_list_permissions, drive_export_file
 * Write (6):       drive_upload_file, drive_create_folder, drive_move_file,
 *                  drive_rename_file, drive_copy_file, drive_share_file
 * Destructive (1): drive_delete_file
 */
export function createDriveTools(
  opts: DriveAdapterOptions,
): ToolDefinition<z.ZodTypeAny, unknown>[] {
  const drive = createDriveClient(opts.accessToken);

  return [
    // Read tools (5)
    createListFilesTool(drive),
    createReadFileTool(drive),
    createGetFileInfoTool(drive),
    createListPermissionsTool(drive),
    createExportFileTool(drive),

    // Write tools (6)
    createUploadFileTool(drive),
    createCreateFolderTool(drive),
    createMoveFileTool(drive),
    createRenameFileTool(drive),
    createCopyFileTool(drive),
    createShareFileTool(drive),

    // Destructive tools (1)
    createDeleteFileTool(drive),
  ] as unknown as ToolDefinition<z.ZodTypeAny, unknown>[];
}

// Re-export error types for consumers
export { DriveAdapterError } from './errors';
export type { DriveErrorCode } from './errors';

// Re-export operation descriptors for UI and registry consumers
export { DRIVE_OPERATIONS } from './operations';
