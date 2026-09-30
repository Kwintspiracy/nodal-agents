import { describe, it, expect } from 'vitest';
import { COMMUNITY_SKILL_CATALOG } from '../community-skill-catalog';

describe('COMMUNITY_SKILL_CATALOG', () => {
  it("ships Comfy's official skills from the comfy-cli repository, named official, instead of the Hermes port", () => {
    const bySlug = new Map(COMMUNITY_SKILL_CATALOG.map((e) => [e.slug, e]));
    for (const slug of ['comfy', 'comfy-debug', 'comfy-director']) {
      const e = bySlug.get(slug);
      expect(e?.source).toBe(`Comfy-Org/comfy-cli/comfy_cli/skills/${slug}`);
      expect(e?.sourceHost).toBe('github');
      expect(e?.name).toContain('(official)');
      expect(e?.description).toContain('comfy-cli');
    }
    // One ComfyUI path offered, not two that would contradict each other.
    expect(bySlug.has('comfyui')).toBe(false);
  });

  it('every entry has a complete, install-ready shape', () => {
    for (const e of COMMUNITY_SKILL_CATALOG) {
      expect(e.slug).toMatch(/^[a-z0-9-]+$/);
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.description.length).toBeGreaterThan(0);
      expect(e.source.trim().length).toBeGreaterThan(0);
      expect(['github', 'skills-sh']).toContain(e.sourceHost);
      expect(e.category.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate slugs', () => {
    const slugs = COMMUNITY_SKILL_CATALOG.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('every github source is an owner/repo/subpath triple', () => {
    for (const e of COMMUNITY_SKILL_CATALOG.filter((x) => x.sourceHost === 'github')) {
      // owner/repo + at least one path segment so the installer fetches a subdir.
      expect(e.source.split('/').length).toBeGreaterThanOrEqual(3);
    }
  });

  it('seeds the curated high-demand starter set', () => {
    const slugs = new Set(COMMUNITY_SKILL_CATALOG.map((e) => e.slug));
    for (const expected of [
      'comfy',
      'excel-author',
      'pptx-author',
      'ocr-and-documents',
      'youtube-content',
      'whisper',
      'osint-investigation',
      'stocks',
    ]) {
      expect(slugs).toContain(expected);
    }
  });
});
