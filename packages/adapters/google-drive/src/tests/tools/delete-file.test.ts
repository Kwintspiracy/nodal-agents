// @nodalai/adapter-google-drive — drive_delete_file tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { drive_v3 } from 'googleapis';
import { createDeleteFileTool } from '../../tools/delete-file';

function makeDrive(): drive_v3.Drive {
  return {
    files: {
      update: vi.fn(),
    },
  } as unknown as drive_v3.Drive;
}

describe('drive_delete_file', () => {
  let drive: drive_v3.Drive;

  beforeEach(() => {
    drive = makeDrive();
  });

  it('moves a file to trash', async () => {
    (drive.files.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'file-1', name: 'old-doc.pdf', trashed: true },
    });

    const tool = createDeleteFileTool(drive);
    const result = await tool.execute({ file_id: 'file-1' }, {} as never);

    expect(result.id).toBe('file-1');
    expect(result.trashed).toBe(true);
  });

  it('calls files.update with trashed: true', async () => {
    (drive.files.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'file-1', name: 'doc.pdf', trashed: true },
    });

    const tool = createDeleteFileTool(drive);
    await tool.execute({ file_id: 'file-1' }, {} as never);

    const callArgs = (drive.files.update as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      requestBody: { trashed: boolean };
    };
    expect(callArgs?.requestBody?.trashed).toBe(true);
  });

  it('maps 401 to drive_unauthorized', async () => {
    (drive.files.update as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createDeleteFileTool(drive);
    await expect(tool.execute({ file_id: 'x' }, {} as never)).rejects.toMatchObject({
      code: 'drive_unauthorized',
    });
  });

  it('maps 404 to drive_not_found', async () => {
    (drive.files.update as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 404,
      message: 'Not Found',
    });

    const tool = createDeleteFileTool(drive);
    await expect(tool.execute({ file_id: 'missing' }, {} as never)).rejects.toMatchObject({
      code: 'drive_not_found',
    });
  });

  it('has riskLevel destructive', () => {
    expect(createDeleteFileTool(drive).riskLevel).toBe('destructive');
  });
});
