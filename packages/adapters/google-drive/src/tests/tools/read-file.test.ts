// @nodal-agents/adapter-google-drive — drive_read_file tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { drive_v3 } from 'googleapis';
import { createReadFileTool } from '../../tools/read-file';

function makeDrive(): drive_v3.Drive {
  return {
    files: {
      get: vi.fn(),
      export: vi.fn(),
    },
  } as unknown as drive_v3.Drive;
}

describe('drive_read_file', () => {
  let drive: drive_v3.Drive;

  beforeEach(() => {
    drive = makeDrive();
  });

  it('exports a Google Doc as plain text', async () => {
    (drive.files.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        id: 'doc-1',
        name: 'My Doc',
        mimeType: 'application/vnd.google-apps.document',
        size: null,
      },
    });
    (drive.files.export as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: 'Hello from Google Docs',
    });

    const tool = createReadFileTool(drive);
    const result = await tool.execute({ file_id: 'doc-1' }, {} as never);

    expect(result.content).toContain('Hello from Google Docs');
    expect(result.mimeType).toBe('application/vnd.google-apps.document');
    expect(result.truncated).toBe(false);
  });

  it('exports a Google Sheet as CSV', async () => {
    (drive.files.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        id: 'sheet-1',
        name: 'My Sheet',
        mimeType: 'application/vnd.google-apps.spreadsheet',
        size: null,
      },
    });
    (drive.files.export as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: 'col1,col2\nval1,val2',
    });

    const tool = createReadFileTool(drive);
    const result = await tool.execute({ file_id: 'sheet-1' }, {} as never);

    expect(result.content).toContain('col1');
    expect(result.truncated).toBe(false);
  });

  it('downloads and returns plain text for text/plain files', async () => {
    (drive.files.get as ReturnType<typeof vi.fn>)
      // First call: metadata
      .mockResolvedValueOnce({
        data: {
          id: 'txt-1',
          name: 'readme.txt',
          mimeType: 'text/plain',
          size: '100',
        },
      })
      // Second call: media download
      .mockResolvedValueOnce({
        data: Buffer.from('Plain text content here'),
      });

    const tool = createReadFileTool(drive);
    const result = await tool.execute({ file_id: 'txt-1' }, {} as never);

    expect(result.content).toContain('Plain text content here');
  });

  it('truncates content exceeding 15000 chars', async () => {
    const longContent = 'x'.repeat(20000);
    (drive.files.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        id: 'doc-long',
        name: 'Long Doc',
        mimeType: 'application/vnd.google-apps.document',
        size: null,
      },
    });
    (drive.files.export as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: longContent,
    });

    const tool = createReadFileTool(drive);
    const result = await tool.execute({ file_id: 'doc-long' }, {} as never);

    expect(result.truncated).toBe(true);
    expect(result.content).toContain('[...file truncated at 15000 chars...]');
  });

  it('throws drive_file_too_large for files > 25 MB', async () => {
    const sizeOver25MB = 26 * 1024 * 1024;
    (drive.files.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        id: 'huge-1',
        name: 'huge.pdf',
        mimeType: 'application/pdf',
        size: String(sizeOver25MB),
      },
    });

    const tool = createReadFileTool(drive);
    await expect(tool.execute({ file_id: 'huge-1' }, {} as never)).rejects.toMatchObject({
      code: 'drive_file_too_large',
    });
  });

  it('maps 401 to drive_unauthorized', async () => {
    (drive.files.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createReadFileTool(drive);
    await expect(tool.execute({ file_id: 'x' }, {} as never)).rejects.toMatchObject({
      code: 'drive_unauthorized',
    });
  });

  it('maps 404 to drive_not_found', async () => {
    (drive.files.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 404,
      message: 'Not Found',
    });

    const tool = createReadFileTool(drive);
    await expect(tool.execute({ file_id: 'missing' }, {} as never)).rejects.toMatchObject({
      code: 'drive_not_found',
    });
  });

  it('has riskLevel read', () => {
    expect(createReadFileTool(drive).riskLevel).toBe('read');
  });
});
