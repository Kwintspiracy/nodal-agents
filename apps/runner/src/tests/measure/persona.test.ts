// persona.test.ts — the sheet variant of the #977 measure (`--persona-file`, #995):
// reading a variant file, the fingerprint a record carries, the report line, and
// the CLI refusing a bad file before it touches any database.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  describePersona,
  describeStoredPersona,
  loadPersonaFile,
  personaFingerprint,
  personaInfo,
} from '../../measure/persona.ts';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'persona-measure-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('loadPersonaFile', () => {
  it('reads the file as written (trailing newline kept), and names it by its base name only', () => {
    const file = join(tmp(), 'no-narration.md');
    writeFileSync(file, 'Line one.\nLine two, avec des accents é à.\n', 'utf8');
    expect(loadPersonaFile(file)).toEqual({
      text: 'Line one.\nLine two, avec des accents é à.\n',
      file: 'no-narration.md',
    });
  });

  it('drops a leading byte-order mark (what Windows editors write) and nothing else', () => {
    const file = join(tmp(), 'bom.md');
    writeFileSync(
      file,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Sheet.', 'utf8')]),
    );
    expect(loadPersonaFile(file).text).toBe('Sheet.');
  });

  it.each([
    ['empty', ''],
    ['blank', '  \n\t \r\n'],
  ])('refuses an %s file', (_label, content) => {
    const file = join(tmp(), 'blank.md');
    writeFileSync(file, content);
    expect(() => loadPersonaFile(file)).toThrow(/is empty/);
  });

  it('refuses a missing file, naming it', () => {
    const file = join(tmp(), 'nope.md');
    expect(() => loadPersonaFile(file)).toThrow(/nope\.md: cannot be read/);
  });

  it('refuses a file that is not valid UTF-8 rather than playing replacement characters', () => {
    const file = join(tmp(), 'latin1.md');
    writeFileSync(file, Buffer.from([0x53, 0x68, 0x65, 0x65, 0x74, 0xe9]));
    expect(() => loadPersonaFile(file)).toThrow(/not valid UTF-8/);
  });
});

describe('persona fingerprint and report line', () => {
  it('is the first 12 hex digits of the sha256 of the UTF-8 bytes, and the length in characters', () => {
    const text = 'Sheet é';
    expect(personaFingerprint(text)).toEqual({
      sha256: createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex').slice(0, 12),
      length: 7,
    });
  });

  it('says a file variant by its name, and the stored sheet as unchanged', () => {
    const variant = { text: 'Variant.', file: 'v.md' };
    const file = personaInfo('Variant.', variant);
    expect(describePersona(file)).toBe(`persona: file v.md, sha256 ${file.sha256}, 8 chars`);
    const stored = personaInfo('Stored sheet.', undefined);
    expect(stored).toEqual({ source: 'stored', ...personaFingerprint('Stored sheet.') });
    expect(describePersona(stored)).toBe(
      `persona: the stored sheet, unchanged, sha256 ${stored.sha256}, 13 chars`,
    );
  });

  it('a stored run without a persona field says so, and never invents one', () => {
    expect(describeStoredPersona(undefined, [{}, {}])).toBe(
      'persona: not recorded (measured before --persona-file existed)',
    );
    const info = personaInfo('Variant.', { text: 'Variant.', file: 'v.md' });
    expect(describeStoredPersona(undefined, [{ persona: info }, { persona: info }])).toBe(
      describePersona(info),
    );
    expect(describeStoredPersona(info, [{}])).toBe(describePersona(info));
  });
});

// The CLI runs as a process: a bad file must stop it with exit code 2 BEFORE the
// database is opened (the URL below points nowhere: had the CLI reached it, the
// message would be about the connection, not about the file).
describe('spoken-reasoning-cli', () => {
  const runnerDir = resolve(import.meta.dirname, '..', '..', '..');
  const cli = join(runnerDir, 'src', 'measure', 'spoken-reasoning-cli.ts');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
      cwd: runnerDir,
      encoding: 'utf8',
      timeout: 60_000,
    });
  const base = (out: string) => [
    '--database-url',
    'postgres://nobody@127.0.0.1:1/none',
    '--agent',
    'alfred',
    '--out',
    out,
  ];

  it('stops before any database work on a missing persona file', () => {
    const d = tmp();
    const r = run(...base(join(d, 'out.json')), '--persona-file', join(d, 'missing.md'));
    expect({ status: r.status, stderr: r.stderr.trim() }).toEqual({
      status: 2,
      stderr: expect.stringMatching(
        /^spoken-reasoning: persona file .*missing\.md: cannot be read/,
      ),
    });
  });

  it('stops before any database work on an empty persona file', () => {
    const d = tmp();
    const empty = join(d, 'empty.md');
    writeFileSync(empty, '');
    const r = run(...base(join(d, 'out.json')), '--persona-file', empty);
    expect({ status: r.status, stderr: r.stderr.trim() }).toEqual({
      status: 2,
      stderr: expect.stringMatching(/^spoken-reasoning: persona file .*empty\.md: is empty/),
    });
  });

  it('--rescore keeps working on an old run that has no persona field, and says so', () => {
    const d = tmp();
    const old = join(d, 'old.json');
    writeFileSync(
      old,
      JSON.stringify({
        teammateNames: [],
        records: [
          {
            effort: 'off',
            run: 1,
            requestId: 'fact',
            needsTask: false,
            calledRunTask: false,
            rightDecision: true,
            firstDeltaMs: 10,
            totalMs: 20,
            replyOutputTokens: 5,
            turnOutputTokens: 5,
            calls: [],
            opening: '',
            reply: 'Canberra.',
            routingNarration: false,
            launchNarration: false,
            replyWords: 1,
            replySentences: 1,
          },
        ],
      }),
    );
    const r = run('--rescore', old);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('persona: not recorded (measured before --persona-file existed)');
    expect(r.stdout).toContain('rescored 1 turns');
  });
});
