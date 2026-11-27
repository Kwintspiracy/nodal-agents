// Google Drive adapter operation descriptors.
// Each slug MUST match the tool name produced by createDriveTools() exactly.
// Risk classification:
//   read        — drive_list_files, drive_read_file, drive_get_file_info,
//                 drive_list_permissions, drive_export_file
//   write       — drive_upload_file, drive_create_folder, drive_move_file,
//                 drive_rename_file, drive_copy_file
//   destructive — drive_delete_file, drive_share_file
//
// drive_share_file is `destructive` + requiresApproval (#744): it emails the
// invited person and can make the file public to anyone with the link or grant
// ownership; none of that can be taken back (outbound = permanent side-effect).

import type { OperationDescriptor, ScopeRequirement } from '@nodal-agents/shared';

// OAuth right, from the Drive API reference: the files.* and permissions.*
// calls the tools make on the person's existing files need the Drive scope.
const DRIVE: ScopeRequirement = ['https://www.googleapis.com/auth/drive'];

export const DRIVE_OPERATIONS: OperationDescriptor[] = [
  // ─── Read (5) ────────────────────────────────────────────────────────────────
  {
    slug: 'drive_list_files',
    name: 'List files',
    risk: 'read',
    requiresApproval: false,
    scopes: [DRIVE],
    description: 'Search and list files in Google Drive.',
  },
  {
    slug: 'drive_read_file',
    name: 'Read file',
    risk: 'read',
    requiresApproval: false,
    scopes: [DRIVE],
    description: 'Download and read file content.',
  },
  {
    slug: 'drive_get_file_info',
    name: 'Get file info',
    risk: 'read',
    requiresApproval: false,
    scopes: [DRIVE],
    description: 'Retrieve file metadata (name, size, mimeType, owners).',
  },
  {
    slug: 'drive_list_permissions',
    name: 'List permissions',
    risk: 'read',
    requiresApproval: false,
    scopes: [DRIVE],
    description: 'List sharing permissions on a file or folder.',
  },
  {
    slug: 'drive_export_file',
    name: 'Export file',
    risk: 'read',
    requiresApproval: false,
    scopes: [DRIVE],
    description: 'Export a Google Workspace file (Docs, Sheets) to a target format.',
  },

  // ─── Write (6) ───────────────────────────────────────────────────────────────
  {
    slug: 'drive_upload_file',
    name: 'Upload file',
    risk: 'write',
    requiresApproval: false,
    scopes: [DRIVE],
    description: 'Upload a new file to Google Drive.',
  },
  {
    slug: 'drive_create_folder',
    name: 'Create folder',
    risk: 'write',
    requiresApproval: false,
    scopes: [DRIVE],
    description: 'Create a new folder.',
  },
  {
    slug: 'drive_move_file',
    name: 'Move file',
    risk: 'write',
    requiresApproval: false,
    scopes: [DRIVE],
    description: 'Move a file to a different folder.',
  },
  {
    slug: 'drive_rename_file',
    name: 'Rename file',
    risk: 'write',
    requiresApproval: false,
    scopes: [DRIVE],
    description: 'Rename a file or folder.',
  },
  {
    slug: 'drive_copy_file',
    name: 'Copy file',
    risk: 'write',
    requiresApproval: false,
    scopes: [DRIVE],
    description: 'Make a copy of a file.',
  },
  {
    slug: 'drive_share_file',
    name: 'Share file',
    risk: 'destructive',
    requiresApproval: true,
    scopes: [DRIVE],
    description: 'Add or update sharing permissions on a file.',
  },

  // ─── Destructive (1) ─────────────────────────────────────────────────────────
  {
    slug: 'drive_delete_file',
    name: 'Delete file',
    risk: 'destructive',
    requiresApproval: true,
    scopes: [DRIVE],
    description: 'Permanently delete a file or folder from Google Drive.',
  },
];
