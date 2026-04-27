// @nodalai/adapter-google-drive — drive_upload_file tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { drive_v3 } from 'googleapis';
import { createUploadFileTool } from '../../tools/upload-file.js';

function makeDrive(): drive_v3.Drive {
  return {
    files: {
      create: vi.fn(),
    },
  } as unknown as drive_v3.Drive;
}

describe('drive_upload_file', () => {
  let drive: drive_v3.Drive;

  beforeEach(() => {
    drive = makeDrive();
  });

  it('creates a file and returns id and name', async () => {
    (drive.files.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        id: 'new-file-1',
        name: 'cover.txt',
        webViewLink: 'https://drive.google.com/file/d/new-file-1/view',
      },
    });

    const tool = createUploadFileTool(drive);
    const result = await tool.execute({ name: 'cover.txt', content: 'Hello World' }, {} as never);

    expect(result.id).toBe('new-file-1');
    expect(result.name).toBe('cover.txt');
  });

  it('passes folder_id as parent when provided', async () => {
    (drive.files.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'file-in-folder', name: 'note.txt', webViewLink: '' },
    });

    const tool = createUploadFileTool(drive);
    await tool.execute({ name: 'note.txt', content: 'note', folder_id: 'folder-123' }, {} as never);

    const callArgs = (drive.files.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      requestBody: drive_v3.Schema$File;
    };
    expect(callArgs?.requestBody?.parents).toContain('folder-123');
  });

  it('maps 401 to drive_unauthorized', async () => {
    (drive.files.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createUploadFileTool(drive);
    await expect(tool.execute({ name: 'f.txt', content: 'x' }, {} as never)).rejects.toMatchObject({
      code: 'drive_unauthorized',
    });
  });

  it('maps 403 to drive_forbidden (quota exceeded scenario)', async () => {
    (drive.files.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 403,
      message: 'Forbidden',
    });

    const tool = createUploadFileTool(drive);
    await expect(tool.execute({ name: 'f.txt', content: 'x' }, {} as never)).rejects.toMatchObject({
      code: 'drive_forbidden',
    });
  });

  it('has riskLevel write', () => {
    expect(createUploadFileTool(drive).riskLevel).toBe('write');
  });
});
