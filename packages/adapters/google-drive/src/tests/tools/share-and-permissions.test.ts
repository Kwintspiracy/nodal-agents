// @nodal-agents/adapter-google-drive — drive_share_file and drive_list_permissions tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { drive_v3 } from 'googleapis';
import { createShareFileTool } from '../../tools/share-file';
import { createListPermissionsTool } from '../../tools/list-permissions';

function makeDrive(): drive_v3.Drive {
  return {
    permissions: {
      create: vi.fn(),
      list: vi.fn(),
    },
  } as unknown as drive_v3.Drive;
}

// ── drive_share_file ──────────────────────────────────────────────────────────

describe('drive_share_file', () => {
  let drive: drive_v3.Drive;

  beforeEach(() => {
    drive = makeDrive();
  });

  it('shares with a user by email', async () => {
    (drive.permissions.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'perm-1', role: 'reader', type: 'user', emailAddress: 'bob@example.com' },
    });

    const tool = createShareFileTool(drive);
    const result = await tool.execute(
      { file_id: 'file-1', email: 'bob@example.com', role: 'reader' },
      {} as never,
    );

    expect(result.permission_id).toBe('perm-1');
    expect(result.role).toBe('reader');
    expect(result.email).toBe('bob@example.com');
  });

  it('creates anyone-with-link sharing when no email provided', async () => {
    (drive.permissions.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'perm-2', role: 'reader', type: 'anyone', emailAddress: null },
    });

    const tool = createShareFileTool(drive);
    await tool.execute({ file_id: 'file-1' }, {} as never);

    const callArgs = (drive.permissions.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      requestBody: drive_v3.Schema$Permission;
    };
    expect(callArgs?.requestBody?.type).toBe('anyone');
  });

  it('maps 401 to drive_unauthorized', async () => {
    (drive.permissions.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createShareFileTool(drive);
    await expect(tool.execute({ file_id: 'x' }, {} as never)).rejects.toMatchObject({
      code: 'drive_unauthorized',
    });
  });

  it('maps 403 to drive_forbidden', async () => {
    (drive.permissions.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 403,
      message: 'Forbidden',
    });

    const tool = createShareFileTool(drive);
    await expect(tool.execute({ file_id: 'x' }, {} as never)).rejects.toMatchObject({
      code: 'drive_forbidden',
    });
  });

  it('has riskLevel write', () => {
    expect(createShareFileTool(drive).riskLevel).toBe('write');
  });
});

// ── drive_list_permissions ────────────────────────────────────────────────────

describe('drive_list_permissions', () => {
  let drive: drive_v3.Drive;

  beforeEach(() => {
    drive = makeDrive();
  });

  it('returns a list of permissions', async () => {
    (drive.permissions.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        permissions: [
          {
            id: 'p1',
            role: 'owner',
            type: 'user',
            emailAddress: 'owner@example.com',
            displayName: 'Owner',
          },
          { id: 'p2', role: 'reader', type: 'anyone', emailAddress: null, displayName: null },
        ],
      },
    });

    const tool = createListPermissionsTool(drive);
    const result = await tool.execute({ file_id: 'file-1' }, {} as never);

    expect(result.total).toBe(2);
    expect(result.permissions[0]?.role).toBe('owner');
    expect(result.permissions[1]?.type).toBe('anyone');
  });

  it('returns empty list when no permissions found', async () => {
    (drive.permissions.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { permissions: [] },
    });

    const tool = createListPermissionsTool(drive);
    const result = await tool.execute({ file_id: 'file-1' }, {} as never);

    expect(result.total).toBe(0);
    expect(result.permissions).toHaveLength(0);
  });

  it('maps 401 to drive_unauthorized', async () => {
    (drive.permissions.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createListPermissionsTool(drive);
    await expect(tool.execute({ file_id: 'x' }, {} as never)).rejects.toMatchObject({
      code: 'drive_unauthorized',
    });
  });

  it('has riskLevel read', () => {
    expect(createListPermissionsTool(drive).riskLevel).toBe('read');
  });
});
