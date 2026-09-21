// internal-tools.test.ts — the descriptors the dashboard renders for the
// always-on built-in tools.
//
// This file exists here rather than in apps/web for one reason: it is the only
// place that can import BOTH the runtime's tool list (`@nodal-agents/tools`)
// and the descriptors the UI consumes, so it can assert they agree. apps/web
// deliberately does not depend on `@nodal-agents/tools` — that package pulls in
// the Office document libraries, which have no business in a dashboard bundle
// for sixteen labels.
//
// The drift this catches: someone adds a seventeenth always-on tool to the
// runtime. Without this check it silently never appears in the Autonomy screen,
// and the owner has a capability they were never offered a control for.

import { describe, it, expect } from 'vitest';
import { ALWAYS_ON_TOOLS, ALWAYS_ON_TOOL_DOCS } from '@nodal-agents/tools';
import { INTERNAL_TOOL_DESCRIPTORS } from '../router/internal-tools';

describe('INTERNAL_TOOL_DESCRIPTORS', () => {
  it('covers every always-on tool, in the same order, and invents none', () => {
    expect(INTERNAL_TOOL_DESCRIPTORS.map((d) => d.slug)).toEqual([...ALWAYS_ON_TOOLS]);
  });

  it('takes both owner texts from the tool definition itself, not a copy', () => {
    // A copy would drift: the owner would read what the tool used to do while
    // deciding whether to switch off what it does now.
    for (const d of INTERNAL_TOOL_DESCRIPTORS) {
      const doc = ALWAYS_ON_TOOL_DOCS.find((x) => x.name === d.slug);
      expect(doc, `${d.slug} missing from ALWAYS_ON_TOOL_DOCS`).toBeDefined();
      expect(d.label).toBe(doc!.label);
      expect(d.summary).toBe(doc!.summary);
    }
  });

  it('carries no model-facing description at all (issue #382)', () => {
    // The screen showed this field verbatim: a wall of instructions written
    // for the model. The descriptor cannot carry it any more, so it cannot
    // come back by a careless spread on the way to the dashboard.
    for (const d of INTERNAL_TOOL_DESCRIPTORS) {
      expect(Object.keys(d), `${d.slug} still ships a description`).not.toContain('description');
    }
  });

  it('gives every tool a label that is not just its slug', () => {
    for (const d of INTERNAL_TOOL_DESCRIPTORS) {
      expect(d.label, `${d.slug} has no label`).toBeTruthy();
      expect(d.label, `${d.slug} fell back to its slug`).not.toBe(d.slug);
      expect(d.summary, `${d.slug} has no summary`).toBeTruthy();
    }
  });

  it('marks return_result as unblockable, and nothing else', () => {
    const locked = INTERNAL_TOOL_DESCRIPTORS.filter((d) => d.unblockableReason !== undefined);
    expect(locked.map((d) => d.slug)).toEqual(['return_result']);
  });
});
