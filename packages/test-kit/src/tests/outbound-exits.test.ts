// outbound-exits.test.ts — the outbound scanner, proved on temporary trees: a
// fake exit beside the seam is found, in every form the packages declare, and
// the forms that go through the seam are not.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OUTBOUND_BRAND_CAST,
  outboundProjectionExits,
  scanForOutboundBypass,
  type OutboundExit,
} from '../outbound-exits';
import { mkdtempSourceTree } from '../source-files';

let dir: string;

const write = (rel: string, text: string): void => {
  const file = join(dir, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
};

beforeAll(() => {
  dir = mkdtempSourceTree('outbound-');
  // A sink reached directly, its text raw: an exit beside the seam.
  write('raw-send.ts', 'await client.chat.postMessage({ channel: c, text: reply });\n');
  // The same sink, its text through the seam.
  write(
    'masked-send.ts',
    'await client.chat.postMessage({ channel: c, text: outboundText(reply) });\n',
  );
  // Spread over lines, as a formatter writes it: still read.
  write(
    'multiline-send.ts',
    'await client.chat\n  .postMessage({\n    channel: c,\n    text:\n      reply,\n  })\n  .catch(() => {});\n',
  );
  // One field masked, the other raw: still a raw exit.
  write(
    'half-masked.ts',
    'await interaction.reply({ content: outboundText(a), embeds: [], text: b });\n',
  );
  // A shorthand property carries its value raw.
  write('shorthand.ts', 'await handle.send(jid, { text });\n');
  // A payload built elsewhere and handed whole: unreadable here, so refused.
  write('payload.ts', 'const p = { content: t };\nawait interaction.followUp(p);\n');
  // A payload handed whole THROUGH the seam is fine.
  write('payload-masked.ts', 'await interaction.followUp(outboundValue(p));\n');
  // The `text:` of an argument already inside a seam call is not read as raw.
  write('nested.ts', 'await handle.send(jid, outboundFields({ text: chunk }));\n');
  // A named exemption goes through the seam, on purpose.
  write(
    'exempt.ts',
    "await handle.send(jid, { text: outboundAsIs(code, 'pairing-credential') });\n",
  );
  // A comment that names a sink is not code.
  write(
    'comment.ts',
    '// client.chat.postMessage({ text: reply }) is how Slack is reached\nexport {};\n',
  );
  // Forbidden forms.
  write(
    'projection.ts',
    'db.select({ id: agentJobs.id, result: agentJobs.result }).from(agentJobs);\n',
  );
  write(
    'projection-ok.ts',
    'db.select({ result: outboundColumn(agentJobs.result) }).from(agentJobs);\n',
  );
  write('row.ts', 'db.select({ job: agentJobs, n: agents.name }).from(agentJobs);\n');
  write('row-ok.ts', 'db.select({ job: outboundColumns(agentJobs) }).from(agentJobs);\n');
  write(
    'aggregate.ts',
    'db.select({\n  first: sql<\n    string | null\n  >`(array_agg(${agentJobs.task}))[1]`,\n}).from(agentJobs);\n',
  );
  write(
    'aggregate-ok.ts',
    'db.select({ first: outboundSql(sql<string>`(array_agg(${agentJobs.task}))[1]`) }).from(agentJobs);\n',
  );
  write(
    'filter-ok.ts',
    'db.select({ id: agentJobs.id }).from(agentJobs).where(eq(agentJobs.task, t));\n',
  );
  write('implicit.ts', 'db\n  .select()\n  .from(agentJobs);\n');
  write('relational.ts', 'db.query.agentJobs.findFirst({ where: w });\n');
  write('returning.ts', 'db.insert(agentJobs).values(v).returning();\n');
  write('cast.ts', 'const x = raw as Outbound<string>;\n');
  // Tests are not read: their fixtures name sinks on purpose.
  write('tests/fixture.ts', 'await client.chat.postMessage({ text: reply });\n');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SLACK: OutboundExit = {
  rule: 'raw-sdk-send',
  call: /\bchat\s*\.\s*postMessage\s*\(/,
  fields: ['text', 'content'],
};
const SEND: OutboundExit = {
  rule: 'raw-sdk-send',
  call: /\.\s*(?:send|reply|followUp)\s*\(/,
  fields: ['text', 'content'],
};
const PROJECTION = outboundProjectionExits({ agentJobs: ['task', 'result'] });

const filesOf = (exits: readonly OutboundExit[]): string[] =>
  scanForOutboundBypass({ srcDir: dir }, exits)
    .map((v) => v.file.split(/[\\/]/).pop()!)
    .sort();

describe('scanForOutboundBypass', () => {
  it('finds a sink reached with its text raw, on one line or spread over several', () => {
    expect(filesOf([SLACK])).toEqual(['multiline-send.ts', 'raw-send.ts']);
  });

  it('finds a raw field beside a masked one, a shorthand, and a payload built elsewhere', () => {
    expect(filesOf([SEND])).toEqual(['half-masked.ts', 'payload.ts', 'shorthand.ts']);
  });

  it('finds every raw projection of a column of agent text, and none through the seam or in a filter', () => {
    expect(filesOf(PROJECTION)).toEqual([
      'aggregate.ts',
      'implicit.ts',
      'projection.ts',
      'relational.ts',
      'returning.ts',
      'row.ts',
    ]);
  });

  it('finds a cast to the brand', () => {
    expect(filesOf([OUTBOUND_BRAND_CAST])).toEqual(['cast.ts']);
  });

  it('names the file, the line where the exit starts, and the rule', () => {
    const [v] = scanForOutboundBypass({ srcDir: dir, skipFiles: ['raw-send.ts'] }, [SLACK]);
    expect(v).toMatchObject({ line: 1, rule: 'raw-sdk-send', text: 'await client.chat' });
    expect(v!.file.endsWith('multiline-send.ts')).toBe(true);
  });

  it('a file of the seam itself is spared only when named', () => {
    expect(filesOf([SLACK])).toContain('raw-send.ts');
    expect(
      scanForOutboundBypass({ srcDir: dir, skipFiles: ['raw-send.ts', 'multiline-send.ts'] }, [
        SLACK,
      ]),
    ).toEqual([]);
  });
});
