// agent-baseline.test.ts — the three behavior layers injected into every agent.

import { describe, it, expect } from 'vitest';
import {
  buildBaselineBlock,
  buildChannelBlock,
  buildDiscoverabilityBlock,
} from '../agent-baseline';
import { systemSkills, skillKind, capabilitySkillSlugs } from '@nodal-agents/catalog';

const baselineContent = systemSkills
  .filter((s) => skillKind(s) === 'baseline')
  .map((s) => s.content.trim());

describe('Layer 1 — baseline discipline', () => {
  it('injects the content of every baseline skill for any agent', () => {
    const block = buildBaselineBlock('anthropic/claude-sonnet-4.6');
    expect(block).toContain('## How you work');
    expect(baselineContent.length).toBeGreaterThan(0);
    for (const c of baselineContent) {
      // a stable slice of each baseline skill's body must be present
      expect(block).toContain(c.slice(0, 40));
    }
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

  it('is empty when the agent already has everything', () => {
    const block = buildDiscoverabilityBlock({
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
      attachedMcpSlugs: [],
      workspaceConnectors: [],
      workspaceMcps: [],
    });
    expect(block).toBe('');
  });
});
