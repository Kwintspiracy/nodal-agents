// sandbox.test.ts — the confinement seam, and the wiring that makes it early.
//
// ## History, because it explains the shape of these cases
//
// The first version of this file pinned "codex is refused on Windows", built on
// a measurement that turned out to be wrong: `codex exec --sandbox` DOES confine
// on Windows — what disabled it was the owner's own `~/.codex/config.toml`,
// which Nodal was loading. Passing `--ignore-user-config` closes it. See
// sandbox.ts for the A/B.
//
// So the refusal is gone, and asserting it would now pin a disproven claim in
// place. What remains worth testing is the SEAM and its ORDER:
//
//   - no provider is refused today, on any platform (an over-broad guard would
//     silently remove codex from the dominant OS);
//   - the guard is wired into `preflight`, not `execute`, so a future refusal
//     lands BEFORE the approval card rather than after a human approves.
//
// The second point is the one two review passes caught, twice, in this same PR:
// testing a helper in isolation says nothing about whether the shipped tool
// still calls it.

import { describe, it, expect } from 'vitest';
import { providerConfinementHolds, assertSandboxEnforced } from './sandbox';
import type { CodeTaskProvider } from './providers';

const PLATFORMS: NodeJS.Platform[] = ['win32', 'linux', 'darwin', 'freebsd'];
const PROVIDERS: CodeTaskProvider[] = ['claude', 'codex'];

describe('providerConfinementHolds', () => {
  it('holds for both providers on every platform we ship to', () => {
    // The regression this guards against is an over-broad refusal. Blocking
    // codex on Windows — as this file asserted for one commit — removes a
    // working feature from most users on a premise that was measured wrong.
    for (const platform of PLATFORMS) {
      for (const provider of PROVIDERS) {
        expect(
          providerConfinementHolds(provider, platform),
          `${provider} was declared unconfined on ${platform} without a measurement`,
        ).toBe(true);
      }
    }
  });
});

describe('assertSandboxEnforced', () => {
  it('refuses nothing today, on any platform', () => {
    for (const platform of PLATFORMS) {
      for (const provider of PROVIDERS) {
        expect(
          () => assertSandboxEnforced(provider, 'read', platform),
          `${provider}/read was refused on ${platform}`,
        ).not.toThrow();
        expect(
          () => assertSandboxEnforced(provider, 'write', platform),
          `${provider}/write was refused on ${platform}`,
        ).not.toThrow();
      }
    }
  });
});

describe('the shipped code_task keeps its refusal seam ahead of the approval', () => {
  it('declares preflight, not a check buried in execute', async () => {
    // Review nº2 killed the previous suite with one mutation: delete
    // `preflight` from codeTaskTool and all 50 tests stayed green, because
    // every case tested a helper or a purpose-built fake tool.
    //
    // This asserts the property that survives the refusal being empty today:
    // the shipped tool routes its confinement check through `preflight`, which
    // `executeTool` runs BEFORE writing an approval request. Put the check back
    // in `execute()` and a human would again approve a card for a run that
    // cannot honour it.
    const { codeTaskTool } = await import('./index');
    expect(
      typeof codeTaskTool.preflight,
      'code_task no longer declares preflight — a future refusal would arrive after approval',
    ).toBe('function');
  });

  it('preflight stays quiet for the combinations that are confined', async () => {
    const { codeTaskTool } = await import('./index');
    for (const provider of PROVIDERS) {
      expect(() =>
        codeTaskTool.preflight?.(
          {
            purpose: 'p',
            provider,
            task: 't',
            mode: 'read',
          } as never,
          {} as never,
        ),
      ).not.toThrow();
    }
  });
});
