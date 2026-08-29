// recipes.test.ts — the recipes that ship with the product.
//
// The assertion that matters most is the last describe block: every skill a
// recipe attaches must actually exist in the catalogue. A recipe pointing at a
// missing slug does not fail loudly — it produces an agent that is quietly
// worse than the one the user asked for, missing exactly the discipline the
// recipe existed to give it.
//
// The rest pins the product decisions, so that changing one is a deliberate
// act rather than a slip: a recipe creates ONE agent, a team only groups them,
// and a developer declares that it needs a folder.

import { describe, it, expect } from 'vitest';
import {
  agentRecipes,
  agentTeams,
  findAgentRecipe,
  recipesOfTeam,
  recipeSkillMeta,
  developerRecipe,
  codeReviewerRecipe,
  teamLeadRecipe,
  devTeam,
} from '../recipes/index';
import { systemSkills } from '../index';

const shippedSlugs = new Set(systemSkills.map((s) => s.slug));

describe('every recipe attaches skills that actually ship', () => {
  for (const recipe of agentRecipes) {
    it(`${recipe.slug} → ${recipe.skills.join(', ') || '(none)'}`, () => {
      const missing = recipe.skills.filter((s) => !shippedSlugs.has(s));
      expect(missing).toEqual([]);
    });
  }

  it('covers every recipe — the loop above is not vacuous', () => {
    expect(agentRecipes.length).toBeGreaterThan(0);
    expect(agentRecipes.some((r) => r.skills.length > 0)).toBe(true);
  });
});

describe('recipe identity', () => {
  it('has unique slugs', () => {
    const slugs = agentRecipes.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('carries a name, a summary, a purpose and a kit — what the card and the panel show', () => {
    for (const r of agentRecipes) {
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.summary.length).toBeGreaterThan(0);
      // The detail panel is where the user learns what makes this agent
      // special; a recipe without that text would present as a bare form.
      expect(r.purpose.length).toBeGreaterThan(80);
      expect(r.kit.length).toBeGreaterThan(0);
    }
  });

  it('is written in the language of the UI — English, no French copy', () => {
    // The whole dashboard is in English. The first version of these recipes
    // shipped French names and summaries copied from the design document,
    // which put "Développeur" next to "New agent" on screen.
    // Word-bounded: "le" must not match inside "lead", "des" inside "describe".
    const french = new RegExp(
      String.raw`\b(le|la|les|un|une|des|et|dans|relecteur|développeur|écrit|lit|rend)\b`,
      'i',
    );
    for (const r of agentRecipes) {
      for (const text of [r.name, r.summary, r.purpose, ...r.kit]) {
        expect(text, `${r.slug}: "${text}"`).not.toMatch(french);
      }
    }
    for (const t of agentTeams) {
      for (const text of [t.name, t.shape, t.rationale]) {
        expect(text, `${t.slug}: "${text}"`).not.toMatch(french);
      }
    }
  });

  it('resolves by slug, and returns undefined for an unknown one', () => {
    expect(findAgentRecipe('developer')).toBe(developerRecipe);
    expect(findAgentRecipe('nope')).toBeUndefined();
  });
});

describe('a team groups, it does not build', () => {
  // The shape of this data is the guarantee: a team holds recipe slugs and
  // prose. There is no "create the team" entry point to accidentally call,
  // because the first draft of this feature had one and it was wrong.
  it('lists recipes that all resolve', () => {
    for (const team of agentTeams) {
      expect(recipesOfTeam(team)).toHaveLength(team.recipes.length);
    }
  });

  it('explains its shape and why — the knowledge nobody has on arrival', () => {
    for (const team of agentTeams) {
      expect(team.shape.length).toBeGreaterThan(0);
      expect(team.rationale.length).toBeGreaterThan(20);
    }
  });

  it('offers Dev team first — the shape the product supports end to end', () => {
    expect(agentTeams[0]?.slug).toBe('dev-team');
  });
});

describe('the Dev team roles', () => {
  it('the developer declares it needs a folder of its own', () => {
    // Without one it writes into the shared hand-off area — the 27/08
    // incident, four runs in a row. This declaration is what lets the create
    // form ask for it up front instead of letting it be discovered later.
    expect(developerRecipe.needs).toContain('workspace');
  });

  it('the developer declares it needs a way to run code', () => {
    expect(developerRecipe.needs).toContain('code-runtime');
  });

  it('the reviewer does NOT ask for a way to write — and is locked read-only', () => {
    expect(developerRecipe.skills).toContain('dev');
    expect(codeReviewerRecipe.skills).not.toContain('dev');
    expect(codeReviewerRecipe.skills).toContain('code-review');
    // The posture is applied through the existing reviewer preset, which
    // blocks the five writing tools. Declared on the recipe so the detail
    // panel can SHOW it before the agent exists.
    expect(codeReviewerRecipe.presets).toContain('read-only');
    expect(developerRecipe.presets ?? []).not.toContain('read-only');
  });

  it('the lead orchestrates and needs a model that can call tools', () => {
    expect(teamLeadRecipe.role).toBe('router');
    expect(teamLeadRecipe.modelRequirements).toContain('tools');
  });

  it('only the lead orchestrates — the others are workers', () => {
    expect(developerRecipe.role).toBe('worker');
    expect(codeReviewerRecipe.role).toBe('worker');
  });

  it('the team lists all three, lead first', () => {
    expect(recipesOfTeam(devTeam).map((r) => r.slug)).toEqual([
      'team-lead',
      'developer',
      'code-reviewer',
    ]);
  });
});

describe('recipeSkillMeta — what the profile panel gets, and nothing more', () => {
  // The panel is a Client Component. Importing systemSkills there shipped
  // every skill's Markdown body to the browser on each /agents load (codex,
  // #45). The projection carries names and descriptions only.
  const meta = recipeSkillMeta(systemSkills);

  it('covers every skill a recipe attaches', () => {
    for (const r of agentRecipes) {
      for (const slug of r.skills) expect(meta[slug]?.name, slug).toBeTruthy();
    }
  });

  it('carries no skill body', () => {
    for (const m of Object.values(meta)) {
      expect(Object.keys(m).sort()).toEqual(['description', 'name', 'requiredBuiltins', 'slug']);
    }
  });

  it('is limited to the skills the recipes use — not the whole catalogue', () => {
    expect(Object.keys(meta).length).toBeLessThan(systemSkills.length);
  });
});
