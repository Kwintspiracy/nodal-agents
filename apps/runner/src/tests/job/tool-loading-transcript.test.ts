// tool-loading-transcript.test.ts — what a turn loads, and what it sends (#612).
//
// Loaded tools are recorded from each turn's calls (the job row keeps them);
// the transcript only adds the deferred tools its tool-call parts name, so no
// provider sees a call to a tool it was not given.

import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import {
  deferredToolNames,
  toolsCalledInTranscript,
  toolsLoadedByCalls,
  toolsSentThisTurn,
} from '../../job/tool-loading.ts';

const TOOLS = [
  { name: 'return_result', loading: 'eager' as const },
  { name: 'list_schedules' },
  { name: 'create_schedule' },
  { name: 'file_read', loading: 'eager' as const },
  { name: 'gmail_send', loading: 'deferred' as const },
];
const DEFERRED = deferredToolNames(TOOLS);

const call = (toolName: string, input: unknown): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: `c-${toolName}`, toolName, input }],
});

describe('what a turn loads @cap:assigner-outils/moteur', () => {
  it('load_tools names and direct deferred calls, in call order, each once', () => {
    const added = toolsLoadedByCalls(
      [
        { name: 'load_tools', input: { names: [' gmail_send ', 'list_schedules', 'gmail_send'] } },
        { name: 'create_schedule', input: { name: 'x' } },
        { name: 'file_read', input: { path: 'a' } },
      ],
      DEFERRED,
      [],
    );
    expect(added).toEqual(['gmail_send', 'list_schedules', 'create_schedule']);
  });

  it('adds nothing already loaded, nothing not held, nothing from a malformed input', () => {
    const added = toolsLoadedByCalls(
      [
        { name: 'load_tools', input: { names: ['list_schedules', 'run_command'] } },
        { name: 'load_tools', input: 'garbage' },
        { name: 'run_command', input: {} },
      ],
      DEFERRED,
      ['list_schedules'],
    );
    expect(added).toEqual([]);
  });
});

describe('the schemas a turn sends @cap:assigner-outils/moteur', () => {
  it('a job that loaded nothing sends its eager tools only, in whitelist order', () => {
    const sent = toolsSentThisTurn(TOOLS, [], [{ role: 'user', content: 'hi' }]);
    expect(sent.map((t) => t.name)).toEqual(['return_result', 'file_read']);
  });

  it('then the loaded tools in load order, then any deferred tool the transcript calls', () => {
    const messages = [call('create_schedule', { name: 'x' }), call('list_schedules', {})];
    expect(
      toolsSentThisTurn(TOOLS, ['gmail_send', 'list_schedules'], messages).map((t) => t.name),
    ).toEqual(['return_result', 'file_read', 'gmail_send', 'list_schedules', 'create_schedule']);
  });

  it('a recorded name the job no longer holds is not sent', () => {
    expect(toolsSentThisTurn(TOOLS, ['run_command'], []).map((t) => t.name)).toEqual([
      'return_result',
      'file_read',
    ]);
  });

  it('the transcript is read by tool NAME, which compaction keeps', () => {
    const elided = call(
      'gmail_send',
      '[earlier tool-call arguments elided to fit the context window]',
    );
    expect(toolsCalledInTranscript([elided], DEFERRED)).toEqual(['gmail_send']);
  });
});
