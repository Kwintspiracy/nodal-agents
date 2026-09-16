/**
 * yaml-lite.ts — the smallest YAML reader that can answer a question about a
 * GitHub workflow.
 *
 * Why not a real parser: `apps/docs` has no YAML dependency, and adding one
 * means a lockfile change for two assertions. Why not `toContain` on the raw
 * file, which is what this replaces: `expect(wf).toContain('ref: main')` passes
 * on a `ref: main` that has moved to another job, been commented out, or sits
 * under a step that no longer runs — the string is there either way. A gate
 * that cannot tell those apart is not a gate.
 *
 * Supported, because that is what `.github/workflows/docs.yml` uses: block
 * mappings and sequences, plain and quoted scalars, flow sequences (`[a, b]`),
 * block scalars (`|`, `>`, and their `-` forms), `#` comments outside quotes,
 * and keys with an empty value. NOT supported, and never silently: anchors,
 * aliases, multiple documents, flow mappings, explicit tags. Anything this
 * cannot read, it throws on — a reader that guesses would answer questions
 * about a file it never understood.
 */

export type YamlValue = string | null | YamlValue[] | { [key: string]: YamlValue };

interface Line {
  readonly indent: number;
  readonly raw: string;
  readonly text: string;
  readonly blank: boolean;
  readonly comment: boolean;
}

/** Drop a trailing `# …` comment, leaving `#` inside quotes alone. */
function stripComment(text: string): string {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1] ?? ''))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

function scalar(token: string): YamlValue {
  const value = token.trim();
  if (value === '' || value === '~' || value === 'null') return null;
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw new Error(`yaml-lite: unterminated flow sequence: ${value}`);
    const inner = value.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((part) => scalar(part) as YamlValue);
  }
  if (value.startsWith('{'))
    throw new Error(`yaml-lite: flow mappings are not supported: ${value}`);
  if (value.startsWith('&') || value.startsWith('*')) {
    throw new Error(`yaml-lite: anchors and aliases are not supported: ${value}`);
  }
  if (
    (value.startsWith("'") && value.endsWith("'") && value.length > 1) ||
    (value.startsWith('"') && value.endsWith('"') && value.length > 1)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

class Reader {
  private at = 0;

  constructor(private readonly lines: Line[]) {}

  /** The next line that carries content, or `null` at the end of the file. */
  private peek(): Line | null {
    let i = this.at;
    while (i < this.lines.length && (this.lines[i].blank || this.lines[i].comment)) i += 1;
    this.at = i;
    return i < this.lines.length ? this.lines[i] : null;
  }

  /** A `|` / `>` block: every deeper-indented line, comments and blanks kept. */
  private blockScalar(marker: string, parentIndent: number): string {
    const folded = marker.startsWith('>');
    const body: string[] = [];
    let indent: number | null = null;
    while (this.at < this.lines.length) {
      const line = this.lines[this.at];
      if (!line.blank && line.indent <= parentIndent) break;
      if (!line.blank && indent === null) indent = line.indent;
      body.push(line.blank ? '' : line.raw.slice(indent ?? line.indent));
      this.at += 1;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    return folded ? body.join(' ').replace(/\s+/g, ' ').trim() : body.join('\n');
  }

  /** The value written after `key:` — inline, a block scalar, or a nested node. */
  private valueFor(rest: string, indent: number): YamlValue {
    if (rest === '|' || rest === '>' || rest.match(/^[|>][-+]?$/)) {
      this.at += 1;
      return this.blockScalar(rest, indent);
    }
    if (rest !== '') {
      this.at += 1;
      return scalar(rest);
    }
    this.at += 1;
    const next = this.peek();
    if (!next || next.indent <= indent) return null;
    return this.node(next.indent);
  }

  /** A mapping or a sequence, every entry of which sits at `indent`. */
  node(indent: number): YamlValue {
    const first = this.peek();
    if (!first || first.indent !== indent) {
      throw new Error(`yaml-lite: expected content at indent ${indent}`);
    }
    return first.text.startsWith('- ') || first.text === '-'
      ? this.sequence(indent)
      : this.mapping(indent);
  }

  private sequence(indent: number): YamlValue[] {
    const items: YamlValue[] = [];
    for (;;) {
      const line = this.peek();
      if (!line || line.indent !== indent || !(line.text.startsWith('- ') || line.text === '-')) {
        break;
      }
      const rest = line.text.slice(1).trim();
      const inner = indent + (line.text.length - line.text.slice(1).trimStart().length - 1) + 1;
      if (rest === '') {
        this.at += 1;
        const next = this.peek();
        items.push(next && next.indent > indent ? this.node(next.indent) : null);
        continue;
      }
      const key = rest.match(/^([^\s:][^:]*):(\s.*|)$/);
      if (!key) {
        this.at += 1;
        items.push(scalar(rest));
        continue;
      }
      // `- uses: x` opens a mapping whose first key is indented to where `uses`
      // starts; the rest of the item's keys line up under it.
      const item: Record<string, YamlValue> = {};
      item[key[1].trim()] = this.valueFor(key[2].trim(), inner);
      const next = this.peek();
      if (next && next.indent === inner) Object.assign(item, this.mapping(inner));
      items.push(item);
    }
    return items;
  }

  private mapping(indent: number): Record<string, YamlValue> {
    const map: Record<string, YamlValue> = {};
    for (;;) {
      const line = this.peek();
      if (!line || line.indent !== indent) break;
      if (line.text.startsWith('- ')) break;
      const match = line.text.match(/^([^\s:][^:]*):(\s.*|)$/);
      if (!match) throw new Error(`yaml-lite: cannot read line: ${line.raw}`);
      map[match[1].trim()] = this.valueFor(match[2].trim(), indent);
    }
    return map;
  }
}

/** Read a YAML document. Throws on anything the subset above does not cover. */
export function parseYaml(source: string): YamlValue {
  const lines: Line[] = source.split(/\r?\n/).map((raw) => {
    const trimmed = raw.trimStart();
    return {
      indent: raw.length - trimmed.length,
      raw,
      text: stripComment(trimmed),
      blank: trimmed === '',
      comment: trimmed.startsWith('#'),
    };
  });
  const reader = new Reader(lines);
  const first = lines.find((l) => !l.blank && !l.comment);
  return first ? reader.node(first.indent) : null;
}
