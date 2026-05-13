// Google Drive adapter operation descriptors.
// Each slug MUST match the tool name produced by createDriveTools() exactly.
// Risk classification:
//   read        — drive_list_files, drive_read_file, drive_get_file_info,
//                 drive_list_permissions, drive_export_file
//   write       — drive_upload_file, drive_create_folder, drive_move_file,
//                 drive_rename_file, drive_copy_file, drive_share_file
//   destructive — drive_delete_file

import type { OperationDescriptor } from '@nodal-agents/shared';

export const DRIVE_OPERATIONS: OperationDescriptor[] = [
  // ─── Read (5) ────────────────────────────────────────────────────────────────
  {
    slug: 'drive_list_files',
    name: 'List files',
    risk: 'read',
    requiresApproval: false,
    description: 'Search and list files in Google Drive.',
  },
  {
    slug: 'drive_read_file',
    name: 'Read file',
    risk: 'read',
    requiresApproval: false,
    description: 'Download and read file content.',
  },
  {
    slug: 'drive_get_file_info',
    name: 'Get file info',
    risk: 'read',
    requiresApproval: false,
    description: 'Retrieve file metadata (name, size, mimeType, owners).',
  },
  {
    slug: 'drive_list_permissions',
    name: 'List permissions',
    risk: 'read',
    requiresApproval: false,
    description: 'List sharing permissions on a file or folder.',
  },
  {
    slug: 'drive_export_file',
    name: 'Export file',
    risk: 'read',
    requiresApproval: false,
    description: 'Export a Google Workspace file (Docs, Sheets) to a target format.',
  },

  // ─── Write (6) ───────────────────────────────────────────────────────────────
  {
    slug: 'drive_upload_file',
    name: 'Upload file',
    risk: 'write',
    requiresApproval: false,
    description: 'Upload a new file to Google Drive.',
  },
  {
    slug: 'drive_create_folder',
    name: 'Create folder',
    risk: 'write',
    requiresApproval: false,
    description: 'Create a new folder.',
  },
  {
    slug: 'drive_move_file',
    name: 'Move file',
    risk: 'write',
    requiresApproval: false,
    description: 'Move a file to a different folder.',
  },
  {
    slug: 'drive_rename_file',
    name: 'Rename file',
    risk: 'write',
    requiresApproval: false,
    description: 'Rename a file or folder.',
  },
  {
    slug: 'drive_copy_file',
    name: 'Copy file',
    risk: 'write',
    requiresApproval: false,
    description: 'Make a copy of a file.',
  },
  {
    slug: 'drive_share_file',
    name: 'Share file',
    risk: 'write',
    requiresApproval: false,
    description: 'Add or update sharing permissions on a file.',
  },

  // ─── Destructive (1) ─────────────────────────────────────────────────────────
  {
    slug: 'drive_delete_file',
    name: 'Delete file',
    risk: 'destructive',
    requiresApproval: true,
    description: 'Permanently delete a file or folder from Google Drive.',
  },
];
