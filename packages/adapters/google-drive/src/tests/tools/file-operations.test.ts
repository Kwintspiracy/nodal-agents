// @nodalai/adapter-google-drive — create-folder, move, rename, copy tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { drive_v3 } from 'googleapis';
import { createCreateFolderTool } from '../../tools/create-folder';
import { createMoveFileTool } from '../../tools/move-file';
import { createRenameFileTool } from '../../tools/rename-file';
import { createCopyFileTool } from '../../tools/copy-file';

function makeDrive(): drive_v3.Drive {
  return {
    files: {
      create: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      copy: vi.fn(),
    },
  } as unknown as drive_v3.Drive;
}

// ── drive_create_folder ───────────────────────────────────────────────────────

describe('drive_create_folder', () => {
  let drive: drive_v3.Drive;

  beforeEach(() => {
    drive = makeDrive();
  });

  it('creates a folder', async () => {
    (drive.files.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        id: 'folder-1',
        name: 'Reports',
        webViewLink: 'https://drive.google.com/drive/folders/folder-1',
      },
    });

    const tool = createCreateFolderTool(drive);
    const result = await tool.execute({ name: 'Reports' }, {} as never);

    expect(result.id).toBe('folder-1');
    expect(result.name).toBe('Reports');
  });

  it('creates folder under parent when parent_id provided', async () => {
    (drive.files.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'folder-2', name: 'Sub', webViewLink: '' },
    });

    const tool = createCreateFolderTool(drive);
    await tool.execute({ name: 'Sub', parent_id: 'parent-folder' }, {} as never);

    const callArgs = (drive.files.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      requestBody: drive_v3.Schema$File;
    };
    expect(callArgs?.requestBody?.parents).toContain('parent-folder');
    expect(callArgs?.requestBody?.mimeType).toBe('application/vnd.google-apps.folder');
  });

  it('maps 401 to drive_unauthorized', async () => {
    (drive.files.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createCreateFolderTool(drive);
    await expect(tool.execute({ name: 'Fail' }, {} as never)).rejects.toMatchObject({
      code: 'drive_unauthorized',
    });
  });

  it('has riskLevel write', () => {
    expect(createCreateFolderTool(drive).riskLevel).toBe('write');
  });
});

// ── drive_move_file ───────────────────────────────────────────────────────────

describe('drive_move_file', () => {
  let drive: drive_v3.Drive;

  beforeEach(() => {
    drive = makeDrive();
  });

  it('moves file to new parent', async () => {
    (drive.files.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'file-1', name: 'doc.pdf', parents: ['old-folder'] },
    });
    (drive.files.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'file-1', name: 'doc.pdf', parents: ['new-folder'] },
    });

    const tool = createMoveFileTool(drive);
    const result = await tool.execute(
      { file_id: 'file-1', new_parent_id: 'new-folder' },
      {} as never,
    );

    expect(result.id).toBe('file-1');
    expect(result.parents).toContain('new-folder');
  });

  it('removes old parents when moving', async () => {
    (drive.files.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'file-1', name: 'doc.pdf', parents: ['old-folder'] },
    });
    (drive.files.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'file-1', name: 'doc.pdf', parents: ['new-folder'] },
    });

    const tool = createMoveFileTool(drive);
    await tool.execute({ file_id: 'file-1', new_parent_id: 'new-folder' }, {} as never);

    const updateArgs = (drive.files.update as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      removeParents: string;
    };
    expect(updateArgs?.removeParents).toBe('old-folder');
  });

  it('maps 404 to drive_not_found', async () => {
    (drive.files.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 404,
      message: 'Not Found',
    });

    const tool = createMoveFileTool(drive);
    await expect(
      tool.execute({ file_id: 'missing', new_parent_id: 'folder' }, {} as never),
    ).rejects.toMatchObject({ code: 'drive_not_found' });
  });

  it('has riskLevel write', () => {
    expect(createMoveFileTool(drive).riskLevel).toBe('write');
  });
});

// ── drive_rename_file ─────────────────────────────────────────────────────────

describe('drive_rename_file', () => {
  let drive: drive_v3.Drive;

  beforeEach(() => {
    drive = makeDrive();
  });

  it('renames a file', async () => {
    (drive.files.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'file-1', name: 'new-name.pdf' },
    });

    const tool = createRenameFileTool(drive);
    const result = await tool.execute({ file_id: 'file-1', new_name: 'new-name.pdf' }, {} as never);

    expect(result.name).toBe('new-name.pdf');
  });

  it('maps 401 to drive_unauthorized', async () => {
    (drive.files.update as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createRenameFileTool(drive);
    await expect(tool.execute({ file_id: 'x', new_name: 'y' }, {} as never)).rejects.toMatchObject({
      code: 'drive_unauthorized',
    });
  });

  it('has riskLevel write', () => {
    expect(createRenameFileTool(drive).riskLevel).toBe('write');
  });
});

// ── drive_copy_file ───────────────────────────────────────────────────────────

describe('drive_copy_file', () => {
  let drive: drive_v3.Drive;

  beforeEach(() => {
    drive = makeDrive();
  });

  it('copies a file', async () => {
    (drive.files.copy as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'copy-1', name: 'Copy of doc.pdf', webViewLink: '' },
    });

    const tool = createCopyFileTool(drive);
    const result = await tool.execute({ file_id: 'orig-1' }, {} as never);

    expect(result.id).toBe('copy-1');
    expect(result.name).toBe('Copy of doc.pdf');
  });

  it('passes new_name and folder_id when provided', async () => {
    (drive.files.copy as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'copy-2', name: 'Archive Copy', webViewLink: '' },
    });

    const tool = createCopyFileTool(drive);
    await tool.execute(
      { file_id: 'orig-1', new_name: 'Archive Copy', folder_id: 'archive-folder' },
      {} as never,
    );

    const callArgs = (drive.files.copy as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      requestBody: drive_v3.Schema$File;
    };
    expect(callArgs?.requestBody?.name).toBe('Archive Copy');
    expect(callArgs?.requestBody?.parents).toContain('archive-folder');
  });

  it('maps 404 to drive_not_found', async () => {
    (drive.files.copy as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 404,
      message: 'Not Found',
    });

    const tool = createCopyFileTool(drive);
    await expect(tool.execute({ file_id: 'missing' }, {} as never)).rejects.toMatchObject({
      code: 'drive_not_found',
    });
  });

  it('has riskLevel write', () => {
    expect(createCopyFileTool(drive).riskLevel).toBe('write');
  });
});
