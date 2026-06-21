// skill-files.test.ts — skill_file_read / skill_file_list against a real fs
// skill store. Focus: real content reads + the security boundary (an agent can
// only read its assigned skills' bundles, never escape the skill folder).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillFileReadTool, skillFileListTool } from './skill-files';
import type { ToolContext } from '../../types';

let STORE: string; // the skill store root (~/.nodalai/skills equivalent)
let OUTSIDE: string; // a sibling dir that holds a "secret" the skill must not reach
const SLUG = 'demo-skill';

function ctx(opts: { store?: string; assigned?: string[] }): ToolContext {
  return {
    jobId: '00000000-0000-0000-0000-000000000aaa',
    agentId: '00000000-0000-0000-0000-000000000bbb',
    entityId: '00000000-0000-0000-0000-000000000ccc',
    db: undefined as unknown as ToolContext['db'],
    jobChatId: null,
    skillStoreDir: opts.store,
    assignedSkillSlugs: opts.assigned,
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
