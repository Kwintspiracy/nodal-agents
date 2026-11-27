// tool-result-mask.test.ts — what a tool returns, masked once: exact values, then strict shapes.
//
// The function every tool result goes through before it becomes the model's
// message and the stored row (`executeTool`, the CLI runtimes' recorded
// results). These cases prove the rule on the text itself: every form a
// registered value takes, the order of the two layers, the agent's switch,
// the lighter pass on source code, and the ordinary data that must reach the
// model as it is. Every credential-shaped value is assembled at run time.

import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  fakeAlnum,
  fakeAssignment,
  fakeB64,
  fakePrivateKeyBlock,
  fakePrivateKeyFooter,
  fakePrivateKeyHeader,
  fakeSecret,
} from '@nodal-agents/test-kit';
import {
  REDACTED_TEXT,
  _resetInstallSecretValuesForTests,
  installSecretValues,
  isSourceCodePath,
  maskToolResult,
  maskToolResultText,
  maskedLinesOf,
  registerInstallSecretValues,
  registeredSecrets,
  secretValueForms,
  toolResultKindOf,
  type ToolResultMaskPolicy,
} from '../index';

const TEXT = { sourceCode: false };
const CODE = { sourceCode: true };
/** A value with no credential shape: only the registry can know it is one. */
const plain = (): string => randomBytes(20).toString('hex');
const policy = (values: string[], shapes = true): ToolResultMaskPolicy => ({
  registry: registeredSecrets(values),
  shapes,
});

afterEach(() => {
  _resetInstallSecretValuesForTests();
});

describe('a registered value is hidden in every form it takes in a text @cap:connecter-un-service/moteur', () => {
  it('as stored, trimmed, JSON-escaped, percent-encoded', () => {
    const value = `  ${plain()}"/+&${plain()}  `;
    const p = policy([value]);
    const trimmed = value.trim();
    const texts = [
      `raw: ${value}`,
      `trimmed: [${trimmed}]`,
      `json: ${JSON.stringify({ v: trimmed })}`,
      `url: https://api.example.com/?k=${encodeURIComponent(trimmed)}`,
    ];
    for (const t of texts) {
      const out = maskToolResultText(t, p, TEXT);
      expect(out, t).toContain(REDACTED_TEXT);
      expect(out).not.toContain(trimmed);
      expect(out).not.toContain(JSON.stringify(trimmed).slice(1, -1));
      expect(out).not.toContain(encodeURIComponent(trimmed));
    }
  });

  it('a key of several lines: the whole block, one line of its body, the body joined', () => {
    const lines = [fakeB64(64), fakeB64(64).split('').reverse().join(''), fakeB64(40)];
    const block = fakePrivateKeyBlock('RSA', lines.join('\n'));
    // The registry alone, the shapes off: the value is known, not guessed.
    const p = policy([block], false);
    expect(maskToolResultText(`key:\n${block}\nend`, p, TEXT)).toBe(`key:\n${REDACTED_TEXT}\nend`);
    const one = maskToolResultText(`a log quoting ${lines[1]} once`, p, TEXT);
    expect(one).toBe(`a log quoting ${REDACTED_TEXT} once`);
    const joined = maskToolResultText(`inline=${lines.join('')}`, p, TEXT);
    expect(joined).toBe(`inline=${REDACTED_TEXT}`);
    // The armour lines are labels, not the key: a public block keeps them.
    expect(secretValueForms(block)).not.toContain(fakePrivateKeyHeader('RSA'));
    expect(secretValueForms(block)).not.toContain(fakePrivateKeyFooter('RSA'));
  });

  it('a value shorter than the minimum is not registered: it would hide ordinary words', () => {
    expect(registeredSecrets(['abc123']).size).toBe(0);
    expect(maskToolResultText('abc123 is a word', policy(['abc123']), TEXT)).toBe(
      'abc123 is a word',
    );
  });

  it('values of another workspace are not in this registry: their bytes pass untouched', () => {
    const mine = plain();
    const theirs = plain();
    const out = maskToolResultText(`${mine} ${theirs}`, policy([mine]), TEXT);
    expect(out).toBe(`${REDACTED_TEXT} ${theirs}`);
  });

  it('the install’s own values, registered once, are in the list every registry is built from', () => {
    const own = plain();
    registerInstallSecretValues([own, undefined, null, 'short']);
    expect(installSecretValues()).toEqual([own]);
  });
});

describe('the two layers and the agent’s switch @cap:connecter-un-service/moteur', () => {
  const shaped = (): string => fakeSecret('github', fakeAlnum(36));

  it('switch on: the registered value and the shaped one are both hidden', () => {
    const registered = plain();
    const token = shaped();
    const out = maskToolResultText(`a=${registered} b ${token}`, policy([registered]), TEXT);
    expect(out).not.toContain(registered);
    expect(out).not.toContain(token);
  });

  it('switch off: a shaped value passes, a registered value is still hidden', () => {
    const registered = plain();
    const token = shaped();
    const out = maskToolResultText(`a=${registered} b ${token}`, policy([registered], false), TEXT);
    expect(out).toBe(`a=${REDACTED_TEXT} b ${token}`);
  });

  it('a registered value that also has a shape is hidden once, by the registry', () => {
    const token = shaped();
    expect(maskToolResultText(`x ${token} y`, policy([token]), TEXT)).toBe(`x ${REDACTED_TEXT} y`);
  });

  it('a structured result: every string at any depth, keys and other values kept', () => {
    const registered = plain();
    const token = shaped();
    const result = {
      ok: true,
      count: 3,
      items: [{ body: `see ${token}`, nextPageToken: 'CAESBggDEAEYAQ' }, { note: registered }],
    };
    const { value, masked } = maskToolResult(result, policy([registered]), TEXT);
    expect(masked).toBe(true);
    expect(value).toEqual({
      ok: true,
      count: 3,
      items: [
        { body: `see ${REDACTED_TEXT}`, nextPageToken: 'CAESBggDEAEYAQ' },
        { note: REDACTED_TEXT },
      ],
    });
    // The input is not touched: the copy is what goes on.
    expect(result.items[1]!.note).toBe(registered);
  });

  it('a result with nothing to hide comes back as the same value', () => {
    const result = { ok: true, text: 'nothing secret here' };
    const out = maskToolResult(result, policy([plain()]), TEXT);
    expect(out.masked).toBe(false);
    expect(out.value).toBe(result);
  });
});

describe('ordinary data that merely looks like a secret reaches the model as it is @cap:connecter-un-service/moteur', () => {
  // The false-positive table: each of these is data an agent reads and must
  // read exactly. None may lose a byte, with the shapes on.
  const ordinary: Array<[string, string]> = [
    [
      'a SHA-256 digest',
      `sha256 ${'9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'}`,
    ],
    ['a git commit id', 'commit 3f2c1a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39'],
    ['a UUID', 'job 0f8fad5b-d9cb-469f-a165-70867728950e'],
    [
      'a long base64 image',
      `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=='.repeat(40)}`,
    ],
    ['scikit-learn markup', '<div class="sk-toggleable__content-fitted sk-estimator-doc-link">'],
    ['a dotted class name', 'at org.example.service.MyVeryLongClassName.handleRequest'],
    ['a timestamp pair', 'started 20261127:120000 finished 20261127:120130'],
    [
      'a pagination token in structured output is a field, never judged by its name',
      'CAESBggDEAEYAQ',
    ],
  ];
  for (const [what, text] of ordinary) {
    it(what, () => {
      expect(maskToolResultText(text, policy([plain()]), TEXT)).toBe(text);
    });
  }

  it('source code: names a secret without holding it, every line kept (lighter pass)', () => {
    const code = [
      'const password = process.env.DB_PASSWORD;',
      'API_KEY=process.env.API_KEY',
      'headers = {"api_key": config.get("api_key")}',
      'if (url.includes("?access_token=")) return;',
    ].join('\n');
    expect(maskToolResultText(code, policy([]), CODE)).toBe(code);
    // The same text read as configuration is masked by name: a `.env` holds values.
    expect(maskToolResultText(code, policy([]), TEXT)).not.toBe(code);
  });

  it('source code still loses a key that has a key’s own form', () => {
    const token = fakeSecret('github', fakeAlnum(36));
    const code = `const t = "${token}";`;
    expect(maskToolResultText(code, policy([]), CODE)).toBe(`const t = "${REDACTED_TEXT}";`);
  });

  it('the kind is read from the path the call named', () => {
    expect(toolResultKindOf({ path: 'src/app.ts' })).toEqual(CODE);
    expect(toolResultKindOf({ file_path: 'C:\\work\\tool.py' })).toEqual(CODE);
    expect(toolResultKindOf({ path: 'config/.env' })).toEqual(TEXT);
    expect(toolResultKindOf({ path: 'settings.json' })).toEqual(TEXT);
    expect(toolResultKindOf({ command: 'cat app.ts' })).toEqual(TEXT);
    expect(isSourceCodePath('Makefile')).toBe(false);
  });
});

describe('the lines a mask hides, for the write tools @cap:travailler-sur-des-fichiers/moteur', () => {
  it('names the lines holding a registered value or a shaped one, a block on every line it spans', () => {
    const registered = plain();
    const token = fakeSecret('github', fakeAlnum(36));
    const block = fakePrivateKeyBlock('RSA', [fakeB64(64), fakeB64(64)].join('\n'));
    const text = [
      'NAME=demo',
      `SECRET_A=${registered}`,
      'PORT=8080',
      `TOKEN_B=${token}`,
      block,
      'END=1',
    ].join('\n');
    expect(maskedLinesOf(text, policy([registered]), TEXT)).toEqual([2, 4, 5, 6, 7, 8]);
    expect(maskedLinesOf(text, policy([registered], false), TEXT)).toEqual([2]);
  });
});

describe('cost of the boundary on a large result @cap:connecter-un-service/moteur', () => {
  it('1 MB of output against the registry of a large install stays in the tens of milliseconds', () => {
    // A large install: 60 values (provider keys, connectors, OAuth pairs, MCP
    // variables, bots, webhooks), one of them a key block, every form of each.
    const values = Array.from({ length: 59 }, () => plain());
    values.push(
      fakePrivateKeyBlock('RSA', Array.from({ length: 25 }, () => fakeB64(64)).join('\n')),
    );
    const p = policy(values);
    const line = `${fakeAssignment('USER_NAME', 'demo')} some ordinary log text 0123456789\n`;
    const big = line.repeat(Math.ceil(1_000_000 / line.length)).slice(0, 1_000_000);
    const input = `${big}${values[7]}`;
    const t0 = performance.now();
    const out = maskToolResultText(input, p, TEXT);
    const ms = performance.now() - t0;
    expect(out.endsWith(REDACTED_TEXT)).toBe(true);
    console.warn(
      `[tool-result-mask] 1 MB, ${p.registry.size} registered forms: ${ms.toFixed(1)} ms`,
    );
    expect(ms).toBeLessThan(1500);
  });
});
