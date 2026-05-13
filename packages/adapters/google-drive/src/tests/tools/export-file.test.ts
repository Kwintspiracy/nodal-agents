// @nodal-agents/adapter-google-drive — drive_export_file tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { drive_v3 } from 'googleapis';
import { createExportFileTool } from '../../tools/export-file';

function makeDrive(): drive_v3.Drive {
  return {
    files: {
      export: vi.fn(),
    },
  } as unknown as drive_v3.Drive;
}

describe('drive_export_file', () => {
  let drive: drive_v3.Drive;

  beforeEach(() => {
    drive = makeDrive();
  });

  it('exports a Google Doc as plain text', async () => {
    (drive.files.export as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: 'Meeting notes content here',
    });

    const tool = createExportFileTool(drive);
    const result = await tool.execute({ file_id: 'doc-1', mime_type: 'text/plain' }, {} as never);

    expect(result.content).toContain('Meeting notes content here');
    expect(result.truncated).toBe(false);
    expect(result.mime_type).toBe('text/plain');
  });

  it('exports a Google Sheet as CSV', async () => {
    (drive.files.export as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: 'col1,col2\nval1,val2',
    });

    const tool = createExportFileTool(drive);
    const result = await tool.execute({ file_id: 'sheet-1', mime_type: 'text/csv' }, {} as never);

    expect(result.content).toContain('col1,col2');
    expect(result.truncated).toBe(false);
  });

  it('truncates text exports exceeding 15000 chars', async () => {
    const longContent = 'y'.repeat(20000);
    (drive.files.export as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: longContent,
    });

    const tool = createExportFileTool(drive);
    const result = await tool.execute(
      { file_id: 'doc-long', mime_type: 'text/plain' },
      {} as never,
    );

    expect(result.truncated).toBe(true);
    expect(result.content).toContain('[...export truncated at 15000 chars...]');
  });

  it('handles binary export (PDF) without crashing', async () => {
    const fakePdfBuffer = new ArrayBuffer(1024);
    (drive.files.export as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: fakePdfBuffer,
    });

    const tool = createExportFileTool(drive);
    const result = await tool.execute(
      { file_id: 'doc-1', mime_type: 'application/pdf' },
      {} as never,
    );

    expect(result.truncated).toBe(false);
    expect(result.byte_size).toBe(1024);
    expect(result.content).toContain('Binary export complete');
  });

  it('maps 401 to drive_unauthorized', async () => {
    (drive.files.export as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createExportFileTool(drive);
    await expect(
      tool.execute({ file_id: 'x', mime_type: 'text/plain' }, {} as never),
    ).rejects.toMatchObject({ code: 'drive_unauthorized' });
  });

  it('maps 403 to drive_forbidden', async () => {
    (drive.files.export as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 403,
      message: 'Forbidden',
    });

    const tool = createExportFileTool(drive);
    await expect(
      tool.execute({ file_id: 'x', mime_type: 'text/plain' }, {} as never),
    ).rejects.toMatchObject({ code: 'drive_forbidden' });
  });

  it('has riskLevel read', () => {
    expect(createExportFileTool(drive).riskLevel).toBe('read');
  });
});
