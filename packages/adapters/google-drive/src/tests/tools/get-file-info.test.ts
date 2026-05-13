// @nodal-agents/adapter-google-drive — drive_get_file_info tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { drive_v3 } from 'googleapis';
import { createGetFileInfoTool } from '../../tools/get-file-info';

function makeDrive(): drive_v3.Drive {
  return {
    files: {
      get: vi.fn(),
    },
  } as unknown as drive_v3.Drive;
}

const fakeFileMeta: drive_v3.Schema$File = {
  id: 'file-1',
  name: 'report.pdf',
  mimeType: 'application/pdf',
  size: '204800',
  createdTime: '2024-01-01T00:00:00.000Z',
  modifiedTime: '2024-03-15T12:00:00.000Z',
  owners: [{ displayName: 'Test User', emailAddress: 'user@example.com' }],
  shared: true,
  webViewLink: 'https://drive.google.com/file/d/file-1/view',
  parents: ['folder-abc'],
};

describe('drive_get_file_info', () => {
  let drive: drive_v3.Drive;

  beforeEach(() => {
    drive = makeDrive();
  });

  it('returns complete file metadata', async () => {
    (drive.files.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: fakeFileMeta });

    const tool = createGetFileInfoTool(drive);
    const result = await tool.execute({ file_id: 'file-1' }, {} as never);

    expect(result.id).toBe('file-1');
    expect(result.name).toBe('report.pdf');
    expect(result.mimeType).toBe('application/pdf');
    expect(result.sizeBytes).toBe(204800);
    expect(result.shared).toBe(true);
    expect(result.parents).toContain('folder-abc');
    expect(result.owners).toContain('Test User');
  });

  it('handles files with no size (Google Workspace files)', async () => {
    (drive.files.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { ...fakeFileMeta, size: undefined },
    });

    const tool = createGetFileInfoTool(drive);
    const result = await tool.execute({ file_id: 'file-1' }, {} as never);

    expect(result.sizeBytes).toBeNull();
  });

  it('maps 401 to drive_unauthorized', async () => {
    (drive.files.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createGetFileInfoTool(drive);
    await expect(tool.execute({ file_id: 'x' }, {} as never)).rejects.toMatchObject({
      code: 'drive_unauthorized',
    });
  });

  it('maps 404 to drive_not_found', async () => {
    (drive.files.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 404,
      message: 'Not Found',
    });

    const tool = createGetFileInfoTool(drive);
    await expect(tool.execute({ file_id: 'missing' }, {} as never)).rejects.toMatchObject({
      code: 'drive_not_found',
    });
  });

  it('has riskLevel read', () => {
    expect(createGetFileInfoTool(drive).riskLevel).toBe('read');
  });
});
