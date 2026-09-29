// tool-loading-transcript.test.ts — what a turn sends is read from the
// transcript, so a resume sends what the model last saw (#612).

import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import { toolsLoadedByTranscript, toolsSentThisTurn } from '../../job/tool-loading.ts';

const TOOLS = [
  { name: 'return_result', loading: 'eager' as const },
  { name: 'list_schedules' },
  { name: 'create_schedule' },
  { name: 'file_read', loading: 'eager' as const },
  { name: 'gmail_send', loading: 'deferred' as const },
];

const call = (toolName: string, input: unknown): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: `c-${toolName}`, toolName, input }],
});

describe('the schemas a turn sends @cap:assigner-outils/moteur', () => {
  it('a fresh job sends its eager tools only, in whitelist order', () => {
    const sent = toolsSentThisTurn(TOOLS, [{ role: 'user', content: 'hi' }]);
    expect(sent.map((t) => t.name)).toEqual(['return_result', 'file_read']);
  });

  it('appends loaded tools in the order the transcript first names them, never twice', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      call('load_tools', { names: ['gmail_send', 'list_schedules'] }),
      call('create_schedule', { name: 'x' }),
      call('load_tools', { names: ['gmail_send'] }),
    ];
    expect(toolsSentThisTurn(TOOLS, messages).map((t) => t.name)).toEqual([
      'return_result',
      'file_read',
      'gmail_send',
      'list_schedules',
      'create_schedule',
    ]);
  });

  it('a name the job does not hold loads nothing, however it is asked', () => {
    const messages = [call('load_tools', { names: ['run_command'] }), call('run_command', {})];
    expect(toolsLoadedByTranscript(messages, new Set(['list_schedules']))).toEqual([]);
    expect(toolsSentThisTurn(TOOLS, messages).map((t) => t.name)).toEqual([
      'return_result',
      'file_read',
    ]);
  });

  it('a malformed load_tools input loads nothing and throws nothing', () => {
    const messages = [call('load_tools', 'garbage'), call('load_tools', { names: 'x' })];
    expect(toolsLoadedByTranscript(messages, new Set(['list_schedules']))).toEqual([]);
  });
});
