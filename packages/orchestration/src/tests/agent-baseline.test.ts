// agent-baseline.test.ts — the three behavior layers injected into every agent.

import { describe, it, expect } from 'vitest';
import {
  buildBaselineBlock,
  buildChannelBlock,
  buildDiscoverabilityBlock,
} from '../agent-baseline';
import { systemSkills, skillKind, capabilitySkillSlugs } from '@nodal-agents/catalog';
import { CHANNELS, AUTOMATION_KINDS } from '@nodal-agents/shared';

const baselineSkills = systemSkills.filter((s) => skillKind(s) === 'baseline');
/** Baseline skills that ask for no tool: every agent gets these, always. */
const unconditionalContent = baselineSkills
  .filter((s) => (s.requiredBuiltins ?? []).length === 0)
  .map((s) => s.content.trim());
/** Baseline skills that DO name a tool, and the tools they name. */
const toolDependent = baselineSkills.filter((s) => (s.requiredBuiltins ?? []).length > 0);

describe('Layer 1 — baseline discipline', () => {
  it('injects the content of every tool-free baseline skill for any agent', () => {
    const block = buildBaselineBlock('anthropic/claude-sonnet-4.6');
    expect(block).toContain('## How you work');
    expect(unconditionalContent.length).toBeGreaterThan(0);
    for (const c of unconditionalContent) {
      // a stable slice of each baseline skill's body must be present
      expect(block).toContain(c.slice(0, 40));
    }
  });

  it('carries the platform reflex only when the agent has the tool it names @cap:consulter-l-aide/moteur', () => {
    // The whole point of the block is one sentence: call `nodal_docs` before
    // telling anyone something is unsupported. Injected at an agent that does
    // not hold the tool, it is an order that cannot be followed, which is the
    // failure mode three review passes on `surfaces` already paid for.
    expect(toolDependent.map((s) => s.slug)).toEqual(['platform-support']);
    expect(toolDependent[0]?.requiredBuiltins).toEqual(['nodal_docs']);

    const withTool = buildBaselineBlock('anthropic/claude-sonnet-4.6', {
      availableTools: ['nodal_docs', 'query_memory'],
    });
    expect(withTool).toContain('## The platform you are running in');
    expect(withTool).toContain('nodal_docs');
    expect(withTool).toContain('Look before you say no');

    const withoutTool = buildBaselineBlock('anthropic/claude-sonnet-4.6', {
      availableTools: ['query_memory'],
    });
    expect(withoutTool).not.toContain('## The platform you are running in');
    // and the rest of the baseline is untouched
    expect(withoutTool).toContain('## How you work');

    // Fails closed: an agent whose tools are unknown is not promised one.
    const unknown = buildBaselineBlock('anthropic/claude-sonnet-4.6');
    expect(unknown).not.toContain('## The platform you are running in');
  });

  it('stays off a surface the skill does not declare, even when the tool is there', () => {
    // Reviewer C on #329, P2-9: the tool gate MASKED the `surfaces` field,
    // because chat has no builtins either way. Holding the tool and being on
    // chat is the one case that tells the two apart, and `surfaces: ['job']` is
    // what must decide it.
    expect(toolDependent[0]?.surfaces).toEqual(['job']);
    const chat = buildBaselineBlock('anthropic/claude-sonnet-4.6', {
      surface: 'chat',
      availableTools: ['nodal_docs'],
    });
    expect(chat).not.toContain('## The platform you are running in');
  });

  it('names the incident it exists for, in the words someone would type', () => {
    // The answer the agent must stop giving. Asserted on the shipped content so
    // a rewrite that loses the concrete example is visible.
    const block = buildBaselineBlock('anthropic/claude-sonnet-4.6', {
      availableTools: ['nodal_docs'],
    });
    expect(block).toContain('unsupported');
    expect(block).toContain('Telegram');
    expect(block).toContain('Channels tab');
    // And what to answer instead: a place, not a description.
    expect(block).toContain('the answer is a PLACE');
  });

  it('adds a firmer verification nudge for weaker models (DeepSeek/MiniMax)', () => {
    const strong = buildBaselineBlock('anthropic/claude-sonnet-4.6');
    const weak = buildBaselineBlock('deepseek/deepseek-v4-pro');
    const weak2 = buildBaselineBlock('minimax/minimax-m3');
    expect(weak).toContain('Especially you');
    expect(weak2).toContain('Especially you');
    expect(strong).not.toContain('Especially you');
    // the reinforcement is ADDITIVE — the baseline is still there
    expect(weak).toContain('## How you work');
  });

  // ── La règle de `purpose`, dite une fois ────────────────────────────────────
  //
  // Le gate refuse une demande d'approbation sans phrase, et les schémas
  // portent le champ. Reste à ce que le modèle sache à quoi il sert AVANT de
  // buter dessus : c'est cette phrase, et elle n'existait nulle part.

  it('dit la règle de `purpose` une fois, sans nommer aucun outil @cap:approuver-une-action/moteur', () => {
    const block = buildBaselineBlock('anthropic/claude-sonnet-4.6');

    expect(block).toContain('## When a call has to be approved');
    expect(block).toContain('`purpose`');
    expect(block).toContain('one sentence');
    // Ce qui arrive sans elle, dit au modèle : rien n'est soumis, l'appel revient.
    expect(block).toContain('comes straight back to you');
    // Générique : QUELS outils demandent d'abord vit dans les schémas, pas ici
    // (invariant #1). Une seule occurrence, aussi : le bloc n'est pas répété.
    expect(block).not.toContain('run_command');
    expect(block.match(/## When a call has to be approved/g)).toHaveLength(1);
  });

  it('ne la dit pas sur `chat`, qui n’a aucun outil que la porte suspend', () => {
    const chat = buildBaselineBlock('anthropic/claude-sonnet-4.6', { surface: 'chat' });
    expect(chat).not.toContain('## When a call has to be approved');
  });

  it('ne la dit pas dans une session CLI, qui n’a aucun outil Nodal', () => {
    const cli = buildBaselineBlock('anthropic/claude-sonnet-4.6', { nodalTools: false });
    expect(cli).toBe('');
  });
});

describe('Memory discipline (C1/C2 — every agent)', () => {
  it('injects the memory-truth-loop and memory-hygiene rules for a worker', () => {
    const block = buildBaselineBlock('anthropic/claude-sonnet-4.6', { role: 'agent' });
    expect(block).toContain('## Memory discipline');
    expect(block).toContain('mark_memory_outdated');
    expect(block).toContain('save_memory');
    expect(block).toContain('discovery ban');
  });

  it('injects the same rules for an orchestrator too', () => {
    const block = buildBaselineBlock('anthropic/claude-sonnet-4.6', { role: 'orchestrator' });
    expect(block).toContain('## Memory discipline');
    expect(block).toContain('mark_memory_outdated');
  });

  it('injects even with no role specified (default)', () => {
    const block = buildBaselineBlock('anthropic/claude-sonnet-4.6');
    expect(block).toContain('## Memory discipline');
  });
});

describe('C3 — worker discovery capitalization vs B1 — orchestrator delegation discipline', () => {
  it('a worker gets the "capitalize what you learn" block, not delegation discipline', () => {
    const block = buildBaselineBlock('anthropic/claude-sonnet-4.6', { role: 'agent' });
    expect(block).toContain('## Capitalize what you learn');
    expect(block).not.toContain('## Delegation discipline');
  });

  it('an orchestrator gets the delegation discipline block, not the worker one', () => {
    const block = buildBaselineBlock('anthropic/claude-sonnet-4.6', { role: 'orchestrator' });
    expect(block).toContain('## Delegation discipline');
    expect(block).not.toContain('## Capitalize what you learn');
    expect(block).toContain('return_result');
    expect(block).toContain('templates are immutable');
  });

  it('defaults to the worker block when no role is given', () => {
    const block = buildBaselineBlock('anthropic/claude-sonnet-4.6');
    expect(block).toContain('## Capitalize what you learn');
  });
});

describe('Layer 2 — channel etiquette', () => {
  it('injects channel content only when the agent is on a channel', () => {
    expect(buildChannelBlock({ channel: 'telegram' })).toContain('## Channel etiquette');
    expect(buildChannelBlock({ telegram: true })).toContain('## Channel etiquette');
    expect(buildChannelBlock({ channel: 'api' })).toBe('');
    expect(buildChannelBlock({})).toBe('');
  });
});

describe('Layer 2bis — discoverability', () => {
  const empty = {
    assignedSkillSlugs: [] as string[],
    attachedConnectorSlugs: [] as string[],
    attachedMcpSlugs: [] as string[],
    workspaceConnectors: [] as { slug: string; name: string }[],
    workspaceMcps: [] as { slug: string; name: string }[],
  };

  it('advertises capability skills the agent does NOT have', () => {
    const block = buildDiscoverabilityBlock(empty);
    expect(block).toContain('## Capabilities you can request');
    expect(capabilitySkillSlugs).toContain('obsidian');
    expect(block).toContain('obsidian');
  });

  it('nothing configured → offers web search as a NEW setup needing a Tavily key', () => {
    const block = buildDiscoverabilityBlock(empty);
    expect(block.toLowerCase()).toContain('web search');
    expect(block).toContain('needs a Tavily API key');
    expect(block).toContain('Not set up in this workspace yet');
  });

  it("configured-but-unassigned → says 'already configured, just assign' (Quentin's bug)", () => {
    // Tavily connector + Perplexity MCP are configured in the workspace but not
    // attached to this agent → the agent must NOT ask for a new key.
    const block = buildDiscoverabilityBlock({
      ...empty,
      workspaceConnectors: [{ slug: 'tavily', name: 'Tavily' }],
      workspaceMcps: [{ slug: 'perplexity', name: 'Perplexity' }],
    });
    expect(block).toContain('ALREADY configured in this workspace');
    expect(block).toContain('connector `tavily` (configured)');
    expect(block).toContain('MCP server `perplexity` (configured)');
    // and it must NOT also tell the user to add a Tavily key
    expect(block).not.toContain('needs a Tavily API key');
  });

  it('does NOT re-offer a capability skill that is already assigned', () => {
    const block = buildDiscoverabilityBlock({ ...empty, assignedSkillSlugs: ['obsidian'] });
    expect(block).not.toContain('`obsidian`');
  });

  it('does NOT offer a connector already attached to the agent', () => {
    const block = buildDiscoverabilityBlock({
      ...empty,
      attachedConnectorSlugs: ['tavily'],
      workspaceConnectors: [{ slug: 'tavily', name: 'Tavily' }],
    });
    expect(block.toLowerCase()).not.toContain('tavily');
  });

  const hasEverything = {
    assignedSkillSlugs: capabilitySkillSlugs,
    attachedConnectorSlugs: [
      'tavily',
      'firecrawl',
      'apify',
      'gmail',
      'google-calendar',
      'google-drive',
      'google-sheets',
      'google-docs',
      'notion-oauth',
      'notion',
      'airtable-oauth',
      'airtable',
    ],
    attachedMcpSlugs: [] as string[],
    workspaceConnectors: [] as { slug: string; name: string }[],
    workspaceMcps: [] as { slug: string; name: string }[],
  };

  it('is empty when the agent already has everything and its channels are known', () => {
    const block = buildDiscoverabilityBlock({
      ...hasEverything,
      boundChannelSlugs: [...CHANNELS],
    });
    // Automations are the one thing always worth naming: any agent can be put
    // on a schedule at any time, so there is no "already has it" state for
    // them. The block is therefore never empty in practice — this asserts the
    // rest of it goes quiet.
    expect(block).not.toContain('Skills you can ask');
    expect(block).not.toContain('ALREADY configured');
    expect(block).not.toContain('Not set up in this workspace yet');
    expect(block).not.toContain('Messaging channels you can be given');
    expect(block).toContain('Automations.');
  });
});

describe('Layer 2bis — channels and automations @cap:parler-par-canal-externe/moteur', () => {
  const empty = {
    assignedSkillSlugs: [] as string[],
    attachedConnectorSlugs: [] as string[],
    attachedMcpSlugs: [] as string[],
    workspaceConnectors: [] as { slug: string; name: string }[],
    workspaceMcps: [] as { slug: string; name: string }[],
  };

  it('names every messaging channel the product ships, and where they are set up', () => {
    // The 2026-09-21 incident: asked whether Telegram could be configured, the
    // root agent said it was not supported and offered to build an MCP server.
    // Nothing in its prompt had ever said the word.
    const block = buildDiscoverabilityBlock({ ...empty, boundChannelSlugs: [] });

    expect(CHANNELS).toContain('telegram');
    for (const channel of CHANNELS) expect(block, channel).toContain(`\`${channel}\``);
    // And WHERE, named the way the dashboard names it.
    expect(block).toContain("the agent's settings, Channels tab");
  });

  it('does not offer a channel the agent is already bound to', () => {
    const block = buildDiscoverabilityBlock({ ...empty, boundChannelSlugs: ['telegram'] });
    expect(block).not.toContain('`telegram`');
    expect(block).toContain('`discord`');
  });

  it('does not offer a channel that already has a binding, enabled or not', () => {
    // Reviewer C on #329, passes 1 and 2. A disabled binding used to count as
    // "not bound", so the agent offered to configure Telegram to an owner who
    // had already pasted a token. That is the header's own prohibition,
    // verbatim. It is also not described: `enabled: false` is produced by no
    // screen, and a sentence about turning it back on would point at a switch
    // that does not exist.
    const block = buildDiscoverabilityBlock({
      ...empty,
      boundChannelSlugs: [],
      configuredChannelSlugs: ['telegram'],
    });

    expect(block).not.toContain('`telegram`');
    expect(block).toContain('`discord`');
    // Regression guard, and it is meant to be unfalsifiable today: no code in
    // the repository produces this sentence, and the point is to keep it that
    // way. It described a switch the dashboard does not have.
    expect(block).not.toContain('switched off');
  });

  it('answers from the bindings it is given, whichever field carries them', () => {
    // Either field alone says which channels have no binding. Gating on the
    // narrower one left a caller that knew ALL the bindings saying nothing
    // (Reviewer C, pass 3).
    const fromConfigured = buildDiscoverabilityBlock({
      ...empty,
      configuredChannelSlugs: ['telegram'],
    });
    expect(fromConfigured).toContain('`discord`');
    expect(fromConfigured).not.toContain('`telegram`');

    const fromBound = buildDiscoverabilityBlock({ ...empty, boundChannelSlugs: ['telegram'] });
    expect(fromBound).toContain('`discord`');
    expect(fromBound).not.toContain('`telegram`');
  });

  it('says nothing about channels when the bindings are unknown', () => {
    // Fails closed: offering to set up a channel that is already set up is the
    // exact failure the three-state connector logic exists to avoid.
    const block = buildDiscoverabilityBlock(empty);
    expect(block).not.toContain('Messaging channels you can be given');
  });

  it('names the automations from the product registry, not from a list written here', () => {
    const block = buildDiscoverabilityBlock(empty);
    expect(AUTOMATION_KINDS.map((a) => a.kind)).toEqual(['cron', 'webhook']);
    for (const automation of AUTOMATION_KINDS) {
      expect(block, automation.kind).toContain(`\`${automation.kind}\``);
      expect(block, automation.kind).toContain(automation.where);
    }
    expect(block).toContain('Run board in the sidebar');
  });
});
