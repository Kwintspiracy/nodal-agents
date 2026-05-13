// @nodal-agents/adapter-google-drive — drive_list_files tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { drive_v3 } from 'googleapis';
import { createListFilesTool } from '../../tools/list-files';

function makeDrive(): drive_v3.Drive {
  return {
    files: {
      list: vi.fn(),
    },
  } as unknown as drive_v3.Drive;
}

const fakeFile: drive_v3.Schema$File = {
  id: 'file-1',
  name: 'document.pdf',
  mimeType: 'application/pdf',
  modifiedTime: '2024-01-15T10:00:00.000Z',
  size: '102400',
};

describe('drive_list_files', () => {
  let drive: drive_v3.Drive;

  beforeEach(() => {
    drive = makeDrive();
  });

  it('returns a list of files', async () => {
    (drive.files.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { files: [fakeFile], nextPageToken: null },
    });

    const tool = createListFilesTool(drive);
    const result = await tool.execute({ max_results: 20 }, {} as never);

    expect(result.total).toBe(1);
    expect(result.files[0]?.id).toBe('file-1');
    expect(result.files[0]?.name).toBe('document.pdf');
    expect(result.files[0]?.size).toBe(102400);
  });

  it('passes query param when provided', async () => {
    (drive.files.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { files: [], nextPageToken: null },
    });

    const tool = createListFilesTool(drive);
    await tool.execute({ query: 'name contains "resume"', max_results: 10 }, {} as never);

    const callArgs = (drive.files.list as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      q?: string;
    };
    expect(callArgs?.q).toBe('name contains "resume"');
  });

  it('returns empty list when no files found', async () => {
    (drive.files.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { files: [], nextPageToken: null },
    });

    const tool = createListFilesTool(drive);
    const result = await tool.execute({}, {} as never);

    expect(result.total).toBe(0);
    expect(result.files).toHaveLength(0);
  });

  it('maps 401 to drive_unauthorized', async () => {
    (drive.files.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createListFilesTool(drive);
    await expect(tool.execute({}, {} as never)).rejects.toMatchObject({
      code: 'drive_unauthorized',
    });
  });

  it('maps 403 to drive_forbidden', async () => {
    (drive.files.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 403,
      message: 'Forbidden',
    });

    const tool = createListFilesTool(drive);
    await expect(tool.execute({}, {} as never)).rejects.toMatchObject({
      code: 'drive_forbidden',
    });
  });

  it('has riskLevel read', () => {
    expect(createListFilesTool(drive).riskLevel).toBe('read');
  });
});
