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
  it('advertises capability skills the agent does NOT have', () => {
    const block = buildDiscoverabilityBlock([], []);
    expect(block).toContain('## Capabilities you can request');
    // obsidian is a capability skill → should be offered when unassigned
    expect(capabilitySkillSlugs).toContain('obsidian');
    expect(block).toContain('obsidian');
  });

  it("offers web search via Tavily when no web connector is attached (Quentin's case)", () => {
    const block = buildDiscoverabilityBlock([], []);
    expect(block.toLowerCase()).toContain('web search');
    expect(block.toLowerCase()).toContain('tavily');
  });

  it('does NOT re-offer a capability skill that is already assigned', () => {
    const block = buildDiscoverabilityBlock(['obsidian'], []);
    expect(block).not.toContain('`obsidian`');
  });

  it('does NOT offer a connector that is already attached', () => {
    const block = buildDiscoverabilityBlock([], ['tavily']);
    expect(block.toLowerCase()).not.toContain('tavily');
  });

  it('is empty when the agent already has every capability skill and connector', () => {
    // Assign every capability skill + attach every advertised connector → nothing left.
    const allConnectors = [
      'tavily',
      'firecrawl',
      'apify',
      'gmail',
      'google-drive',
      'google-sheets',
      'google-docs',
      'notion-oauth',
      'notion',
      'airtable-oauth',
      'airtable',
    ];
    const block = buildDiscoverabilityBlock(capabilitySkillSlugs, allConnectors);
    expect(block).toBe('');
  });
});
