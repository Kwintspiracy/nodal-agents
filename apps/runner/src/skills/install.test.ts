// install.test.ts — pure units of the community-skill installer: source-string
// parsing (+ host allowlist), SKILL.md frontmatter parsing/validation, and
// generic script detection. The full network+DB install is validated live.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  parseSkillSource,
  candidateRefs,
  tarballUrl,
  clawhubDownloadUrl,
  SkillSourceError,
} from './source';
import { parseSkillMarkdown, validateFrontmatter, FrontmatterError } from './frontmatter';
import { detectScripts } from './detect-scripts';
import { pickManifest, SkillInstallError } from './install';

describe('parseSkillSource', () => {
  it('parses a github.com repo URL', () => {
    const s = parseSkillSource('https://github.com/zarazhangrui/frontend-slides');
    expect(s.owner).toBe('zarazhangrui');
    expect(s.repo).toBe('frontend-slides');
    expect(s.ref).toBeNull();
    expect(s.subdir).toBeNull();
  });

  it('parses a github tree URL with ref + subdir', () => {
    const s = parseSkillSource('https://github.com/acme/repo/tree/dev/skills/foo');
    expect(s.owner).toBe('acme');
    expect(s.repo).toBe('repo');
    expect(s.ref).toBe('dev');
    expect(s.subdir).toBe('skills/foo');
  });

  it('parses an owner/repo shorthand', () => {
    const s = parseSkillSource('acme/repo');
    expect(s.owner).toBe('acme');
    expect(s.repo).toBe('repo');
  });

  it('parses a skills.sh registry path with skill name', () => {
    const s = parseSkillSource('skills-sh/zarazhangrui/frontend-slides/frontend-slides');
    expect(s.owner).toBe('zarazhangrui');
    expect(s.repo).toBe('frontend-slides');
    expect(s.skillName).toBe('frontend-slides');
  });

  it('parses a raw.githubusercontent SKILL.md URL and drops the filename', () => {
    const s = parseSkillSource(
      'https://raw.githubusercontent.com/acme/repo/main/skills/foo/SKILL.md',
    );
    expect(s.owner).toBe('acme');
    expect(s.ref).toBe('main');
    expect(s.subdir).toBe('skills/foo');
  });

  it('rejects a non-allowlisted host (anti-SSRF)', () => {
    expect(() => parseSkillSource('https://evil.example.com/owner/repo')).toThrow(SkillSourceError);
    expect(() => parseSkillSource('http://169.254.169.254/latest/meta-data')).toThrow(
      SkillSourceError,
    );
  });

  it('rejects unparseable input', () => {
    expect(() => parseSkillSource('not a url or repo')).toThrow(SkillSourceError);
  });

  it('builds the codeload tarball URL and default candidate refs', () => {
    const s = parseSkillSource('acme/repo');
    expect(s.provider).toBe('github');
    expect(candidateRefs(s)).toEqual(['main', 'master']);
    expect(tarballUrl(s, 'main')).toBe('https://codeload.github.com/acme/repo/tar.gz/main');
  });

  it('parses a clawhub.ai URL into a clawhub source', () => {
    const s = parseSkillSource('https://clawhub.ai/danielblinker83-bot/image-studio');
    expect(s.provider).toBe('clawhub');
    expect(s.owner).toBe('danielblinker83-bot');
    expect(s.slug).toBe('image-studio');
    expect(clawhubDownloadUrl(s)).toBe('https://clawhub.ai/api/v1/download?slug=image-studio');
  });

  it('rejects a clawhub URL without a slug', () => {
    expect(() => parseSkillSource('https://clawhub.ai/onlysegment')).toThrow(SkillSourceError);
  });

  it('parses a scheme-less clawhub host as a clawhub source', () => {
    const s = parseSkillSource('clawhub.ai/kelvincai522/comfyui');
    expect(s.provider).toBe('clawhub');
    expect(s.owner).toBe('kelvincai522');
    expect(s.slug).toBe('comfyui');
    expect(clawhubDownloadUrl(s)).toBe('https://clawhub.ai/api/v1/download?slug=comfyui');
  });

  it('parses a scheme-less github.com host as a github source', () => {
    const s = parseSkillSource('github.com/acme/repo');
    expect(s.provider).toBe('github');
    expect(s.owner).toBe('acme');
    expect(s.repo).toBe('repo');
  });

  it('still rejects a scheme-less non-allowlisted host (anti-SSRF)', () => {
    expect(() => parseSkillSource('evil.example.com/owner/repo')).toThrow(SkillSourceError);
  });
});

describe('frontmatter', () => {
  const SKILL_MD = `---
name: frontend-slides
description: Create stunning HTML presentations. Use when building a deck.
license: MIT
metadata:
  author: zara
  version: 1.2.0
---

# Frontend Slides

Body content here.
`;

  it('parses frontmatter fields and returns the body', () => {
    const { frontmatter, body } = parseSkillMarkdown(SKILL_MD);
    expect(frontmatter.name).toBe('frontend-slides');
    expect(frontmatter.description).toContain('HTML presentations');
    expect(frontmatter.license).toBe('MIT');
    expect(frontmatter.metadata?.['author']).toBe('zara');
    expect(frontmatter.metadata?.['version']).toBe('1.2.0');
    expect(body).toContain('# Frontend Slides');
    expect(body).not.toContain('name: frontend-slides');
  });

  it('validateFrontmatter returns slug/name/description for a valid skill', () => {
    const { frontmatter } = parseSkillMarkdown(SKILL_MD);
    const v = validateFrontmatter(frontmatter);
    expect(v.slug).toBe('frontend-slides');
    expect(v.name).toBe('frontend-slides');
    expect(v.description).toContain('HTML presentations');
  });

  it('throws on a missing name', () => {
    const { frontmatter } = parseSkillMarkdown('---\ndescription: x\n---\nbody');
    expect(() => validateFrontmatter(frontmatter)).toThrow(FrontmatterError);
  });

  it('slugifies a community-style name (uppercase/spaces) for the identifier', () => {
    const { frontmatter } = parseSkillMarkdown('---\nname: ComfyUI\ndescription: x\n---\nb');
    const v = validateFrontmatter(frontmatter);
    expect(v.name).toBe('ComfyUI'); // display name preserved
    expect(v.slug).toBe('comfyui'); // safe identifier
  });

  it('slugifies spaces and accents into a hyphenated identifier', () => {
    const { frontmatter } = parseSkillMarkdown('---\nname: PDF Café Tools\ndescription: x\n---\nb');
    const v = validateFrontmatter(frontmatter);
    expect(v.slug).toBe('pdf-cafe-tools');
  });

  it('throws when the name yields no usable identifier', () => {
    const { frontmatter } = parseSkillMarkdown('---\nname: "***"\ndescription: x\n---\nb');
    expect(() => validateFrontmatter(frontmatter)).toThrow(FrontmatterError);
  });

  it('throws on a missing description', () => {
    const { frontmatter } = parseSkillMarkdown('---\nname: ok-skill\n---\nbody');
    expect(() => validateFrontmatter(frontmatter)).toThrow(FrontmatterError);
  });
});

describe('detectScripts', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nodal-detect-'));
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), '# skill\n', 'utf8');
    await writeFile(join(dir, 'styles.css'), 'body{}', 'utf8');
    await writeFile(join(dir, 'scripts', 'extract.py'), 'print(1)\n', 'utf8');
    await writeFile(join(dir, 'scripts', 'deploy.sh'), '#!/bin/bash\necho hi\n', 'utf8');
    // extensionless executable with a shebang
    const ep = join(dir, 'scripts', 'runner');
    await writeFile(ep, '#!/usr/bin/env python3\nprint(2)\n', 'utf8');
    try {
      await chmod(ep, 0o755);
    } catch {
      /* chmod unsupported on this fs — irrelevant, detection is shebang-based */
    }
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('detects script files by extension and shebang, ignoring docs/assets', async () => {
    const scripts = await detectScripts(dir);
    const paths = scripts.map((s) => s.path);
    expect(paths).toContain('scripts/extract.py');
    expect(paths).toContain('scripts/deploy.sh');
    expect(paths).toContain('scripts/runner');
    expect(paths).not.toContain('SKILL.md');
    expect(paths).not.toContain('styles.css');
    const py = scripts.find((s) => s.path === 'scripts/extract.py');
    expect(py?.language).toBe('python');
    const sh = scripts.find((s) => s.path === 'scripts/deploy.sh');
    expect(sh?.language).toBe('shell');
    const ext = scripts.find((s) => s.path === 'scripts/runner');
    expect(ext?.language).toBe('python');
  });

  it('skips excluded subtrees (e.g. a nested plugin mirror with its own SKILL.md)', async () => {
    await mkdir(join(dir, 'plugins', 'mirror', 'scripts'), { recursive: true });
    await writeFile(join(dir, 'plugins', 'mirror', 'scripts', 'extract.py'), 'print(1)', 'utf8');
    const excluded = join(dir, 'plugins', 'mirror');
    const isExcluded = (abs: string): boolean => abs === excluded || abs.startsWith(excluded + sep);
    const scripts = await detectScripts(dir, isExcluded);
    const paths = scripts.map((s) => s.path);
    expect(paths).toContain('scripts/extract.py');
    expect(paths).not.toContain('plugins/mirror/scripts/extract.py');
  });

  it('returns an empty array for a knowledge-only skill', async () => {
    const clean = await mkdtemp(join(tmpdir(), 'nodal-clean-'));
    await writeFile(join(clean, 'SKILL.md'), '# clean\n', 'utf8');
    await writeFile(join(clean, 'ref.md'), 'docs\n', 'utf8');
    const scripts = await detectScripts(clean);
    expect(scripts).toEqual([]);
    await rm(clean, { recursive: true, force: true });
  });
});

describe('pickManifest', () => {
  let root: string;
  async function manifest(rel: string, name: string): Promise<void> {
    const abs = join(root, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, `---\nname: ${name}\ndescription: d\n---\nbody`, 'utf8');
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nodal-pick-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns the single manifest when there is exactly one', async () => {
    await manifest('skills/only/SKILL.md', 'only');
    expect(await pickManifest(root, null, null)).toBe('skills/only/SKILL.md');
  });

  it('prefers the repo-root SKILL.md when a plugin mirror also exists', async () => {
    await manifest('SKILL.md', 'frontend-slides');
    await manifest('plugins/frontend-slides/skills/frontend-slides/SKILL.md', 'frontend-slides');
    expect(await pickManifest(root, null, null)).toBe('SKILL.md');
  });

  it('disambiguates by skillName (frontmatter) when no root manifest', async () => {
    await manifest('skills/alpha/SKILL.md', 'alpha');
    await manifest('skills/beta/SKILL.md', 'beta');
    expect(await pickManifest(root, null, 'beta')).toBe('skills/beta/SKILL.md');
  });

  it('fails loud on multiple skills with no root and no skillName', async () => {
    await manifest('skills/alpha/SKILL.md', 'alpha');
    await manifest('skills/beta/SKILL.md', 'beta');
    await expect(pickManifest(root, null, null)).rejects.toBeInstanceOf(SkillInstallError);
  });

  it('honours an explicit subdir, and fails loud when it has no SKILL.md', async () => {
    await manifest('pkg/foo/SKILL.md', 'foo');
    expect(await pickManifest(root, 'pkg/foo', null)).toBe('pkg/foo/SKILL.md');
    await expect(pickManifest(root, 'pkg/missing', null)).rejects.toBeInstanceOf(SkillInstallError);
  });
});
