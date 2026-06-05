// skills/frontmatter.ts — parse a SKILL.md file (open Agent Skills format):
// YAML frontmatter between `---` fences, followed by the markdown body.
//
// Required fields per the open spec (agentskills.io): name, description.
// Optional: license, allowed-tools, metadata (a string→string map that
// conventionally holds author/version).

import { parse as parseYaml } from 'yaml';

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  license?: string;
  /** Space-separated pre-approval hint, e.g. "Bash(git:*) Read". Recorded, not granted. */
  allowedTools?: string;
  metadata?: Record<string, string>;
  raw: Record<string, unknown>;
}

export interface ParsedSkillMd {
  frontmatter: SkillFrontmatter;
  body: string;
}

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontmatterError';
  }
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Derive a filesystem/DB-safe slug from a skill name. The open spec asks for
 * lowercase-hyphen names, but the wider community ships "ComfyUI", "PDF Tools",
 * etc. We keep the original name for display and slugify a safe identifier:
 * lowercase, accents stripped, non-alphanumeric runs → single hyphens, ≤64 chars.
 */
function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

export function parseSkillMarkdown(content: string): ParsedSkillMd {
  const text = content.replace(/^﻿/, ''); // strip BOM
  const m = FM_RE.exec(text);
  if (!m) {
    return { frontmatter: { raw: {} }, body: text };
  }
  const yamlText = m[1] ?? '';
  const body = m[2] ?? '';

  let raw: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(yamlText) as unknown;
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch {
    // Malformed YAML → empty frontmatter; validateFrontmatter() will fail loud
    // on the missing required name.
  }

  const fm: SkillFrontmatter = { raw };
  if (typeof raw['name'] === 'string') fm.name = raw['name'].trim();
  if (typeof raw['description'] === 'string') fm.description = raw['description'].trim();
  if (typeof raw['license'] === 'string') fm.license = raw['license'].trim();
  const at = raw['allowed-tools'] ?? raw['allowed_tools'];
  if (typeof at === 'string') fm.allowedTools = at.trim();
  if (raw['metadata'] && typeof raw['metadata'] === 'object' && !Array.isArray(raw['metadata'])) {
    fm.metadata = {};
    for (const [k, v] of Object.entries(raw['metadata'] as Record<string, unknown>)) {
      fm.metadata[k] = typeof v === 'string' ? v : String(v);
    }
  }
  return { frontmatter: fm, body };
}

/**
 * Validate the required fields. Keeps the original `name` for display and
 * derives a filesystem/DB-safe `slug` from it (the community ships names like
 * "ComfyUI" or "PDF Tools" that don't follow the lowercase-hyphen convention).
 * Throws FrontmatterError when name/description are missing, the name is absurd,
 * or it yields no usable slug — fail loud rather than installing a broken skill.
 */
export function validateFrontmatter(fm: SkillFrontmatter): {
  slug: string;
  name: string;
  description: string;
} {
  if (!fm.name) {
    throw new FrontmatterError('SKILL.md is missing the required `name` field.');
  }
  const name = fm.name.trim();
  if (name.length > 128) {
    throw new FrontmatterError(`Skill name is too long (${name.length} chars, max 128).`);
  }
  const slug = slugify(name);
  if (!slug) {
    throw new FrontmatterError(
      `Skill name "${name}" has no usable characters for an identifier.`,
    );
  }
  if (!fm.description) {
    throw new FrontmatterError('SKILL.md is missing the required `description` field.');
  }
  return { slug, name, description: fm.description };
}
