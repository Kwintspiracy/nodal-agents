// skill-files.test.ts — skill_file_read / skill_file_list against a real fs
// skill store. Focus: real content reads + the security boundary (an agent can
// only read its assigned skills' bundles, never escape the skill folder).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, stat, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillFileReadTool, skillFileListTool, skillFileWriteTool } from './skill-files';
import { MAX_READ_FILE_BYTES } from '../file-ops/workspace';
import type { ToolContext } from '../../types';

let STORE: string; // the skill store root (~/.nodalai/skills equivalent)
let OUTSIDE: string; // a sibling dir that holds a "secret" the skill must not reach
const SLUG = 'demo-skill';

function ctx(opts: { store?: string; assigned?: string[]; writable?: string[] }): ToolContext {
  return {
    jobId: '00000000-0000-0000-0000-000000000aaa',
    agentId: '00000000-0000-0000-0000-000000000bbb',
    entityId: '00000000-0000-0000-0000-000000000ccc',
    db: undefined as unknown as ToolContext['db'],
    jobChatId: null,
    skillStoreDir: opts.store,
    assignedSkillSlugs: opts.assigned,
    fileWritableSkillSlugs: opts.writable,
  };
}

beforeEach(async () => {
  STORE = await mkdtemp(join(tmpdir(), 'nodal-skillstore-'));
  OUTSIDE = await mkdtemp(join(tmpdir(), 'nodal-skilloutside-'));
  const skillDir = join(STORE, SLUG);
  await mkdir(join(skillDir, 'references'), { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), '# Demo\nbody line 1\nbody line 2\n', 'utf8');
  await writeFile(join(skillDir, 'references', 'guide.md'), 'guide content\n', 'utf8');
  await writeFile(join(OUTSIDE, 'secret.key'), 'TOP SECRET\n', 'utf8');
});

afterEach(async () => {
  await rm(STORE, { recursive: true, force: true });
  await rm(OUTSIDE, { recursive: true, force: true });
});

describe('skill_file_read — happy path', () => {
  it('reads a bundled file and returns its real content', async () => {
    const r = await skillFileReadTool.execute(
      { skill: SLUG, path: 'references/guide.md' },
      ctx({ store: STORE, assigned: [SLUG] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.content).toBe('guide content\n');
    expect(r.total_lines).toBe(2);
  });

  it('paginates with offset/limit', async () => {
    const r = await skillFileReadTool.execute(
      { skill: SLUG, path: 'SKILL.md', offset: 2, limit: 1 },
      ctx({ store: STORE, assigned: [SLUG] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.content).toBe('body line 1');
    expect(r.start_line).toBe(2);
    expect(r.truncated).toBe(true);
  });

  it('refuses a directory path with a helpful reason', async () => {
    const r = await skillFileReadTool.execute(
      { skill: SLUG, path: 'references' },
      ctx({ store: STORE, assigned: [SLUG] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toContain('directory');
  });
});

describe('skill_file_read — security boundary', () => {
  it('blocks `..` traversal out of the skill folder', async () => {
    const r = await skillFileReadTool.execute(
      { skill: SLUG, path: `../../${join(OUTSIDE, 'secret.key').split(/[/\\]/).pop()}` },
      ctx({ store: STORE, assigned: [SLUG] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toMatch(/outside the skill folder|not found/i);
  });

  it('blocks an absolute path pointing outside the store', async () => {
    const r = await skillFileReadTool.execute(
      { skill: SLUG, path: join(OUTSIDE, 'secret.key') },
      ctx({ store: STORE, assigned: [SLUG] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toContain('outside the skill folder');
  });

  it('blocks a symlink that escapes the skill folder', async () => {
    const link = join(STORE, SLUG, 'escape.md');
    try {
      await symlink(join(OUTSIDE, 'secret.key'), link);
    } catch {
      return; // symlink not permitted on this host (e.g. Windows w/o privilege) — skip
    }
    const r = await skillFileReadTool.execute(
      { skill: SLUG, path: 'escape.md' },
      ctx({ store: STORE, assigned: [SLUG] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected symlink escape to be blocked');
    expect(r.reason).toContain('outside the skill folder');
  });

  it('blocks a UNC path before it can trigger an SMB/NTLM handshake', async () => {
    const r = await skillFileReadTool.execute(
      { skill: SLUG, path: '\\\\attacker\\share\\secret.key' },
      ctx({ store: STORE, assigned: [SLUG] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toMatch(/UNC|network path/i);
  });

  it('refuses a skill the agent does not hold', async () => {
    const r = await skillFileReadTool.execute(
      { skill: SLUG, path: 'SKILL.md' },
      ctx({ store: STORE, assigned: ['some-other-skill'] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toContain('not assigned');
  });

  it('fails loud when the skill store is not configured', async () => {
    const r = await skillFileReadTool.execute(
      { skill: SLUG, path: 'SKILL.md' },
      ctx({ store: undefined, assigned: [SLUG] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toContain('skill store is not available');
  });

  it('rejects a malformed slug (potential traversal vector)', async () => {
    const r = await skillFileReadTool.execute(
      { skill: '../evil', path: 'SKILL.md' },
      ctx({ store: STORE, assigned: ['../evil'] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toContain('Invalid skill slug');
  });

  it('refuses a file above the 50 MiB hard cap, even with offset/limit', async () => {
    const bigPath = join(STORE, SLUG, 'huge.bin');
    const handle = await open(bigPath, 'w');
    try {
      const chunk = Buffer.alloc(1024 * 1024, 'x'); // 1 MiB, written repeatedly
      const chunksNeeded = Math.ceil(MAX_READ_FILE_BYTES / (1024 * 1024)) + 1;
      for (let i = 0; i < chunksNeeded; i++) await handle.write(chunk);
    } finally {
      await handle.close();
    }
    const info = await stat(bigPath);
    expect(info.size).toBeGreaterThan(MAX_READ_FILE_BYTES);

    const r = await skillFileReadTool.execute(
      { skill: SLUG, path: 'huge.bin', offset: 1, limit: 100 },
      ctx({ store: STORE, assigned: [SLUG] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected refusal above the hard cap');
    expect(r.reason).toContain('50');
    expect(r.reason.toLowerCase()).toMatch(/cap|too large|exceed/i);
  }, 30000);

  it('streams a windowed read for a file between 1 MiB and the hard cap, matching the reference slice', async () => {
    const lineTemplate = 'ref-line-XXXXXX\n';
    const lineBytes = Buffer.byteLength(lineTemplate, 'utf8');
    const repeats = Math.ceil((1.5 * 1024 * 1024) / lineBytes);
    let full = '';
    for (let i = 0; i < repeats; i++) full += lineTemplate.replace('XXXXXX', String(i).padStart(6, '0'));
    const mediumPath = join(STORE, SLUG, 'medium.txt');
    await writeFile(mediumPath, full, 'utf8');

    const reference = full.split('\n');
    const r = await skillFileReadTool.execute(
      { skill: SLUG, path: 'medium.txt', offset: 100, limit: 50 },
      ctx({ store: STORE, assigned: [SLUG] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    const startIdx = 99;
    const endIdx = Math.min(reference.length, startIdx + 50);
    expect(r.total_lines).toBe(reference.length);
    expect(r.content).toBe(reference.slice(startIdx, endIdx).join('\n'));
  });

  it('reports skill_not_installed when the folder is absent', async () => {
    const r = await skillFileReadTool.execute(
      { skill: 'ghost-skill', path: 'SKILL.md' },
      ctx({ store: STORE, assigned: ['ghost-skill'] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toContain('not installed');
  });
});

describe('skill_file_list', () => {
  it('lists bundled files as paths relative to the skill root', async () => {
    const r = await skillFileListTool.execute(
      { skill: SLUG },
      ctx({ store: STORE, assigned: [SLUG] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    const paths = r.entries.map((e) => e.path);
    expect(paths).toContain('SKILL.md');
    expect(paths).toContain('references');
    expect(paths).toContain('references/guide.md');
    const guide = r.entries.find((e) => e.path === 'references/guide.md');
    expect(guide?.type).toBe('file');
  });

  it('refuses a skill the agent does not hold', async () => {
    const r = await skillFileListTool.execute({ skill: SLUG }, ctx({ store: STORE, assigned: [] }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toContain('not assigned');
  });
});

describe('skill_file_write — happy path', () => {
  it('writes a new file into the skill bundle and it reads back identically', async () => {
    const body = '{"prompt":"a cat"}\n';
    const r = await skillFileWriteTool.execute(
      {
        purpose: 'add a new workflow to the skill',
        skill: SLUG,
        path: 'workflows/new.json',
        content: body,
      },
      ctx({ store: STORE, assigned: [SLUG], writable: [SLUG] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.overwritten).toBe(false);
    expect(r.bytes_written).toBe(Buffer.byteLength(body, 'utf8'));
    // Parent dir 'workflows/' was created and the bytes landed verbatim.
    const onDisk = await readFile(join(STORE, SLUG, 'workflows', 'new.json'), 'utf8');
    expect(onDisk).toBe(body);
  });

  it('overwrites an existing file and reports overwritten=true', async () => {
    const r = await skillFileWriteTool.execute(
      {
        purpose: 'update the skill instructions',
        skill: SLUG,
        path: 'SKILL.md',
        content: '# Replaced\n',
      },
      ctx({ store: STORE, assigned: [SLUG], writable: [SLUG] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.overwritten).toBe(true);
    expect(await readFile(join(STORE, SLUG, 'SKILL.md'), 'utf8')).toBe('# Replaced\n');
  });

  it('refuses to clobber a directory with a file write', async () => {
    const r = await skillFileWriteTool.execute(
      { purpose: 'write into references', skill: SLUG, path: 'references', content: 'x' },
      ctx({ store: STORE, assigned: [SLUG], writable: [SLUG] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toContain('directory');
  });
});

describe('skill_file_write — authorization + boundary', () => {
  it('refuses when the owner has not made the skill file-writable', async () => {
    const r = await skillFileWriteTool.execute(
      { purpose: 'write a workflow', skill: SLUG, path: 'workflows/x.json', content: 'x' },
      // assigned but NOT writable
      ctx({ store: STORE, assigned: [SLUG], writable: [] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toContain('files_not_writable');
    // And nothing was written.
    await expect(stat(join(STORE, SLUG, 'workflows', 'x.json'))).rejects.toThrow();
  });

  it('refuses a skill the agent does not hold (even if listed writable)', async () => {
    const r = await skillFileWriteTool.execute(
      { purpose: 'write a workflow', skill: SLUG, path: 'workflows/x.json', content: 'x' },
      ctx({ store: STORE, assigned: [], writable: [SLUG] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    // writable gate passes but resolveSkillRoot rejects the unassigned skill.
    expect(r.reason).toContain('not assigned');
  });

  it('blocks `..` traversal escaping the skill folder', async () => {
    const r = await skillFileWriteTool.execute(
      { purpose: 'attempt escape', skill: SLUG, path: '../../pwned.key', content: 'x' },
      ctx({ store: STORE, assigned: [SLUG], writable: [SLUG] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toContain('outside the skill folder');
    // The escaping path must not have been created in the OUTSIDE sibling.
    await expect(stat(join(OUTSIDE, 'pwned.key'))).rejects.toThrow();
  });

  it('blocks an absolute path pointing outside the store', async () => {
    const r = await skillFileWriteTool.execute(
      { purpose: 'attempt escape', skill: SLUG, path: join(OUTSIDE, 'pwned.key'), content: 'x' },
      ctx({ store: STORE, assigned: [SLUG], writable: [SLUG] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toContain('outside the skill folder');
  });

  it('is destructive + approval-gated by default (safe posture)', () => {
    expect(skillFileWriteTool.riskLevel).toBe('destructive');
    expect(skillFileWriteTool.defaultApproval).toBe('require_approval');
  });
});
