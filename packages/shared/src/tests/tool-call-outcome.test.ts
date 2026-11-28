// tool-call-outcome.test.ts — one closed set of outcomes, one reader, one
// verdict per target (#1184). The verdict is the one the runner's gate, the
// web and the bench all read: proven here on tables of rows.

import { describe, it, expect } from 'vitest';
import {
  TOOL_CALL_OUTCOMES,
  callMayHaveActed,
  chatItemTarget,
  chatTarget,
  cliCallOutcome,
  filesTarget,
  readCallOutcome,
  readableTarget,
  unresolvedCalls,
  type OutcomeRow,
} from '../tool-call-outcome';

let seq = 0;
const row = (over: Partial<OutcomeRow>): OutcomeRow => ({
  seq: ++seq,
  toolName: 'send_file',
  toolCallId: `c${seq}`,
  outcome: 'done',
  target: null,
  riskLevel: 'write',
  readOnlyHint: null,
  executionStarted: true,
  ...over,
});

describe('the closed set and its one reader @cap:verifier-un-livrable/moteur', () => {
  it('reads every value of the set, a missing one as not recorded, and refuses any other', () => {
    for (const o of TOOL_CALL_OUTCOMES) expect(readCallOutcome(o)).toBe(o);
    expect(readCallOutcome(null)).toBe('not_recorded');
    expect(readCallOutcome(undefined)).toBe('not_recorded');
    expect(() => readCallOutcome('success')).toThrow(/TOOL_CALL_OUTCOME_OUT_OF_SET/);
  });

  it('a failed, refused or held call did not act; done, unknown and not recorded may have', () => {
    expect(
      ['failed', 'refused', 'awaiting_approval'].map((o) => callMayHaveActed(readCallOutcome(o))),
    ).toEqual([false, false, false]);
    expect(['done', 'unknown', null].map((o) => callMayHaveActed(readCallOutcome(o)))).toEqual([
      true,
      true,
      true,
    ]);
  });
});

describe('a failure is resolved only on its own target @cap:verifier-un-livrable/moteur', () => {
  const report = chatItemTarget('telegram', '42', '/ws/report.pdf');
  const cover = chatItemTarget('telegram', '42', '/ws/cover.png');

  it('file A fails, file B succeeds to the same chat: A is still unresolved', () => {
    const rows = [
      row({ outcome: 'failed', target: report }),
      row({ outcome: 'done', target: cover }),
    ];
    expect(unresolvedCalls(rows)).toEqual([
      { toolName: 'send_file', toolCallId: rows[0]!.toolCallId, outcome: 'failed', target: report },
    ]);
  });

  it('a failure then a done call on the SAME target is resolved, whatever the tool', () => {
    const file = filesTarget(['/ws/a.ts'])!;
    expect(
      unresolvedCalls([
        row({ toolName: 'file_edit', outcome: 'failed', target: file }),
        row({ toolName: 'file_write', outcome: 'done', target: file }),
      ]),
    ).toEqual([]);
  });

  it('a done call BEFORE the failure resolves nothing: the order of writing decides', () => {
    const rows = [
      row({ outcome: 'done', target: report }),
      row({ outcome: 'failed', target: report }),
    ];
    expect(unresolvedCalls(rows).map((c) => c.toolCallId)).toEqual([rows[1]!.toolCallId]);
  });

  it('an unknown outcome is unresolved like a failure, and resolved the same way', () => {
    const chat = chatTarget('slack', 'C1');
    expect(
      unresolvedCalls([
        row({ toolName: 'telegram_send_message', outcome: 'unknown', target: chat }),
      ]),
    ).toHaveLength(1);
    expect(
      unresolvedCalls([
        row({ toolName: 'telegram_send_message', outcome: 'unknown', target: chat }),
        row({ toolName: 'telegram_send_message', outcome: 'done', target: chat }),
      ]),
    ).toEqual([]);
  });

  it('what only reads, what the gate refused before it ran, and what is not recorded decide nothing', () => {
    expect(
      unresolvedCalls([
        row({ toolName: 'file_read', riskLevel: 'read', outcome: 'failed', target: 'x' }),
        row({
          toolName: 'mcp__notion__search',
          riskLevel: 'write',
          readOnlyHint: true,
          outcome: 'failed',
        }),
        row({ toolName: 'file_write', outcome: 'failed', executionStarted: false }),
        row({ toolName: 'gmail_send_email', outcome: null }),
        row({ toolName: 'run_command', outcome: 'refused' }),
        row({ toolName: 'run_command', outcome: 'awaiting_approval' }),
      ]),
    ).toEqual([]);
  });

  it('a failure with no target is resolved by nothing', () => {
    expect(
      unresolvedCalls([
        row({ outcome: 'failed', target: null }),
        row({ outcome: 'done', target: null }),
      ]),
    ).toHaveLength(1);
  });

  it('a target the platform carries out itself at completion is made good by it, and only that one', () => {
    const asked = chatTarget('telegram', '42');
    const other = chatTarget('telegram', '7');
    const rows = [
      row({ toolName: 'telegram_send_message', outcome: 'unknown', target: asked }),
      row({ toolName: 'telegram_send_message', outcome: 'failed', target: other }),
      // A FILE sent to the chat that asked is not the answer: its key names it.
      row({
        toolName: 'send_file',
        outcome: 'failed',
        target: chatItemTarget('telegram', '42', '/a.pdf'),
      }),
    ];
    expect(unresolvedCalls(rows, { resolvedTargets: [asked] }).map((c) => c.target)).toEqual([
      other,
      chatItemTarget('telegram', '42', '/a.pdf'),
    ]);
  });
});

describe('the keys and the CLI reading @cap:verifier-un-livrable/moteur', () => {
  it('a target reads as a chat or files, never as the hash of an input', () => {
    expect(readableTarget(chatTarget('telegram', '42'))).toBe('chat:telegram:42');
    expect(readableTarget(filesTarget(['/b', '/a', '/a']))).toBe('file:/a, file:/b');
    expect(readableTarget('input:gmail_send_email:abc')).toBeNull();
    expect(readableTarget(null)).toBeNull();
    expect(filesTarget([])).toBeNull();
  });

  it('a CLI call flagged as an error failed, except a command: its exit status is data', () => {
    expect(cliCallOutcome('Write', true)).toBe('failed');
    expect(cliCallOutcome('Edit', false)).toBe('done');
    expect(cliCallOutcome('file_change', true)).toBe('failed');
    expect(cliCallOutcome('Bash', true)).toBe('done');
    expect(cliCallOutcome('PowerShell', true)).toBe('done');
    expect(cliCallOutcome('command_execution', true)).toBe('done');
  });
});
