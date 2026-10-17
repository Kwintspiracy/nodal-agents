// claude-setting-sources.test.ts — a Nodal-launched `claude -p` never loads the
// settings of the folder it runs in (#628, decision 7).
//
// The risk, measured on claude 2.1.301 (PR #753): a workspace's
// `.claude/settings.json` hooks run on the host, outside the sandbox, with no
// confirmation. `--setting-sources user` closes it. Two argv launch Claude
// headless — the runtime turn and the `code_task` provider — and both must carry
// the flag, from ONE definition (@nodal-agents/shared). This test asserts the
// argv those builders really produce, in every mode and shape, so a third
// launcher or a builder that drops the flag turns it red.
//
// What the CLI does with the flag is NOT provable in CI (no model there): that
// is scripts/probe-claude-setting-sources.mjs, run by hand — see the last test.
//
// Mutations verified: the flag removed from claude-turn.ts → the runtime-turn
// tests red; removed from providers.ts → the code_task tests red; `user`
// changed to `user,project` in claude-setting-sources.ts → every test red.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { buildProviderArgs } from '@nodal-agents/tools';
import { CLAUDE_SETTING_SOURCES, claudeSettingSourcesFlags } from '@nodal-agents/shared';
import {
  buildClaudeTurnArgs,
  finishTurn,
  newStreamParseState,
} from '../../cli-runtime/claude-turn.ts';

const modes = ['read', 'write'] as const;
const reprises = [undefined, 'sess-1'] as const;

/** The value following `--setting-sources`, and how many times the flag appears. */
function settingSources(args: readonly string[]): { value: string | undefined; count: number } {
  const at = args.indexOf('--setting-sources');
  return {
    value: at === -1 ? undefined : args[at + 1],
    count: args.filter((a) => a === '--setting-sources' || a.startsWith('--setting-sources='))
      .length,
  };
}

describe('claude launched headless loads only the user settings (#628) @cap:parler-a-un-agent/moteur', () => {
  it('the shared definition is exactly `--setting-sources user`, never project or local', () => {
    expect(claudeSettingSourcesFlags()).toEqual(['--setting-sources', 'user']);
    expect(CLAUDE_SETTING_SOURCES.split(',')).toEqual(['user']);
  });

  it('runtime turn: the flag is in the argv, once, with `user` only, in every mode and shape', () => {
    for (const mode of modes) {
      for (const resumeSessionId of reprises) {
        for (const extraWriteDirs of [undefined, ['D:\other']] as const) {
          const args = buildClaudeTurnArgs(
            {
              message: 'salut',
              personality: 'Tu es Jarvis.',
              cwd: 'D:\ws',
              mode,
              shellTools: [],
              timeoutMs: 1000,
              ...(resumeSessionId ? { resumeSessionId } : {}),
              ...(extraWriteDirs ? { extraWriteDirs } : {}),
            },
            'D:\tmp\persona.txt',
          );
          expect(settingSources(args), `${mode} ${resumeSessionId ?? ''}`).toEqual({
            value: 'user',
            count: 1,
          });
        }
      }
    }
  });

  it('code_task (claude provider): the flag is in the argv, once, with `user` only, in every mode and shape', () => {
    for (const mode of modes) {
      for (const resumeSessionId of reprises) {
        const args = buildProviderArgs('claude', mode, {
          ...(resumeSessionId ? { resumeSessionId } : {}),
        });
        expect(settingSources(args), `${mode} ${resumeSessionId ?? ''}`).toEqual({
          value: 'user',
          count: 1,
        });
      }
    }
  });

  it('the flag comes from the one shared definition: the same adjacent pair in both argv', () => {
    const pair = claudeSettingSourcesFlags();
    const turn = buildClaudeTurnArgs(
      { message: 'm', personality: 'p', cwd: 'D:\ws', mode: 'read', shellTools: [], timeoutMs: 1 },
      'D:\tmp\persona.txt',
    );
    const task = buildProviderArgs('claude', 'read');
    for (const args of [turn, task]) {
      const at = args.indexOf(pair[0]!);
      expect(args.slice(at, at + pair.length)).toEqual(pair);
    }
  });

  it('codex does not carry it: its project layer is skipped by --ignore-user-config, a different flag', () => {
    const args = buildProviderArgs('codex', 'write', { platform: 'linux' });
    expect(settingSources(args).count).toBe(0);
    expect(args).toContain('--ignore-user-config');
  });

  it('a claude that does not know the flag fails the turn loudly, with its own message (invariant #4)', () => {
    // What an older claude prints and does: `error: unknown option` on stderr,
    // exit 1, no stream at all. The turn must be an error carrying that text,
    // never an empty success and never a retry without the flag.
    const result = finishTurn(
      newStreamParseState(),
      1,
      false,
      12,
      "error: unknown option '--setting-sources'",
    );
    expect(result.isError).toBe(true);
    expect(result.finalText).toBe('');
    expect(result.errorDetail).toContain("unknown option '--setting-sources'");
  });

  it('the by-hand probe asks the CLI for the same flag the product sends', () => {
    // The live measurement (a real model turn) cannot run in CI. It is
    // scripts/probe-claude-setting-sources.mjs; its flag is a literal because it
    // must run from a bare checkout, so this pins it to the shared definition.
    const script = readFileSync(
      fileURLToPath(
        new URL('../../../../../scripts/probe-claude-setting-sources.mjs', import.meta.url),
      ),
      'utf8',
    );
    const m = /const SETTING_SOURCES_ARGS = \[\s*'([^']+)',\s*'([^']+)',?\s*\];/.exec(script);
    expect(m, 'SETTING_SOURCES_ARGS literal not found in the probe').not.toBeNull();
    expect([m![1], m![2]]).toEqual(claudeSettingSourcesFlags());
  });
});
