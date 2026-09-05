// Built-in: skill_view
// Read the full content of a skill by slug — the just-in-time loader for tool
// usage guides. Tool usage skills (e.g. `tool-create-mcp`) are seeded but NOT
// auto-injected into the prompt (that would bloat context); an agent calls
// skill_view RIGHT BEFORE using a tool to load its exact format + examples.
// Mirrors how Hermes exposes `skill_view`. Entity-scoped, read-only.

import { z } from 'zod';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { agentSkills, eq, and } from '@nodal-agents/db';
import type { ToolDefinition, ToolContext } from '../types';
import { resolveSkillRoot } from './skill-ops/skill-files';

export const SkillViewInputSchema = z.object({
  slug: z
    .string()
    .min(1)
    .describe('Slug of the skill to read, e.g. "comfyui" or "tool-create-mcp".'),
});

export type SkillViewInput = z.infer<typeof SkillViewInputSchema>;

type SkillViewOutput = { ok: true; name: string; content: string } | { ok: false; error: string };

/** Bundle subdirs whose concrete files we surface so the model never has to guess paths. */
const MANIFEST_DIRS = ['workflows', 'scripts', 'references', 'templates', 'assets'];

/**
 * Build a manifest of a skill's bundled files (the concrete paths the model
 * would otherwise have to discover via skill_file_list). This is the key
 * Hermes-style steer: give the model the exact path of a ready-made resource
 * (e.g. `workflows/z_image_custom.json`) plus how to run it, so it uses the
 * skill's automation instead of rebuilding it. Best-effort: returns '' if the
 * skill isn't assigned / installed / has no bundled files (e.g. agent-internal
 * tool-usage skills have no bundle).
 */
async function buildBundleManifest(ctx: ToolContext, slug: string): Promise<string> {
  let root: string;
  try {
    root = await resolveSkillRoot(ctx, slug);
  } catch {
    return '';
  }
  const files: string[] = [];
  for (const dir of MANIFEST_DIRS) {
    try {
      const entries = await readdir(join(root, dir), { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && !e.name.startsWith('.')) files.push(`${dir}/${e.name}`);
      }
    } catch {
      /* dir absent — skip */
    }
  }
  if (files.length === 0) return '';
  return (
    `\n\n[Bundled files — ready to use, do NOT rebuild or re-convert them]\n` +
    files.map((f) => `- ${f}`).join('\n') +
    `\n\nRun a bundled script with run_skill_script({ skill: '${slug}', script: '<path>', args: [...] }) — ` +
    `this is the ONLY way to run them. The store's on-disk location is internal: NEVER try to reach a ` +
    `bundled script through run_command with a guessed or relative path (a live incident burned a whole ` +
    `turn on a hand-built "..\\..\\.nodalai\\skills\\..." path that does not exist). ` +
    `Pass a ready-made workflow/template to the skill's run script AS-IS (e.g. its run_workflow.py with ` +
    `--workflow workflows/<file>), with per-run values (prompt, seed) as --args. NEVER save a new ` +
    `workflow/template file just to change a prompt or seed — run the existing file with different args. ` +
    `Never hand-convert or re-implement what the bundle already provides.`
  );
}

export const skillViewTool: ToolDefinition<typeof SkillViewInputSchema, SkillViewOutput> = {
  name: 'skill_view',
  description:
    "Load a skill's FULL instructions by slug, on demand. Call this the moment a skill listed in " +
    'your Skills index is relevant — BEFORE acting — to get its complete guidance, the exact paths ' +
    'of its bundled files (scripts, ready-made workflows/templates), and how to run them. Also loads ' +
    "a tool's usage guide right before you call that tool (e.g. skill_view('tool-create-mcp')). " +
    'Follow what it returns instead of reimplementing the skill yourself.',
  inputSchema: SkillViewInputSchema,
  riskLevel: 'read',
  card: 'read',
  execute: async (input, ctx) => {
    const [row] = await ctx.db
      .select({ name: agentSkills.name, content: agentSkills.content })
      .from(agentSkills)
      .where(and(eq(agentSkills.entityId, ctx.entityId), eq(agentSkills.slug, input.slug)));
    if (!row) return { ok: false, error: `No skill found with slug "${input.slug}".` };
    const manifest = await buildBundleManifest(ctx, input.slug);
    return { ok: true, name: row.name, content: (row.content ?? '') + manifest };
  },
};
