// no-arbitrary-text.test.ts — the arbitrary-text-size detector must actually
// DETECT the banned pattern (and only the real thing, not comments mentioning
// it as prose). Mirrors figma-drift.test.ts: exercise the pure function with
// fixtures rather than trusting "it currently passes".
import { describe, expect, it } from 'vitest';
import { findViolations, stripComments } from '../scripts/check-no-arbitrary-text.mjs';

describe('stripComments', () => {
  it('blanks out block and line comments without shifting line numbers', () => {
    const src = `const a = 1;\n/* text-[14px] in a comment */\nconst b = 2; // text-[12px] too\n`;
    const stripped = stripComments(src);
    expect(stripped.split('\n')).toHaveLength(src.split('\n').length);
    expect(stripped).not.toContain('text-[14px]');
    expect(stripped).not.toContain('text-[12px]');
  });
});

describe('findViolations', () => {
  it('flags a real className usage', () => {
    const src = `export default function X() {\n  return <p className="text-[14px] text-ink">hi</p>;\n}\n`;
    const hits = findViolations(src);
    expect(hits).toEqual([{ line: 2, matches: ['text-[14px]'] }]);
  });

  it('flags fractional and multiple sizes on one line', () => {
    const src = `const cls = \`text-[12.5px] \${x ? 'text-[13.5px]' : ''}\`;\n`;
    const hits = findViolations(src);
    expect(hits).toEqual([{ line: 1, matches: ['text-[12.5px]', 'text-[13.5px]'] }]);
  });

  it('ignores mentions inside comments', () => {
    const src = `// legacy usage was text-[11px], now migrated\nconst ok = 'text-body-14';\n`;
    expect(findViolations(src)).toEqual([]);
  });

  it('passes on ramp/legacy utilities (no arbitrary bracket size)', () => {
    const src = `<span className="text-body-14 text-legacy-12-5 font-medium" />;\n`;
    expect(findViolations(src)).toEqual([]);
  });
});
