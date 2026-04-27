// @nodalai/adapter-notion — Notion property value coercion helpers

// ── Chunk rich_text ───────────────────────────────────────────────────────────

/**
 * Split a string into Notion rich_text chunks of ≤2000 UTF-16 code units each.
 * Notion measures length in UTF-16 code units; astral-plane characters count as 2.
 */
export function chunkRichText(
  content: string | null | undefined,
  annotations?: Record<string, unknown>,
): Array<{ type: 'text'; text: { content: string }; annotations?: Record<string, unknown> }> {
  const s = content == null ? '' : String(content);
  if (!s) return [{ type: 'text', text: { content: '' } }];

  const items: Array<{
    type: 'text';
    text: { content: string };
    annotations?: Record<string, unknown>;
  }> = [];
  const buf: string[] = [];
  let units = 0;

  for (const ch of s) {
    const cu = ch.codePointAt(0)! > 0xffff ? 2 : 1;
    if (units + cu > 2000) {
      const item: {
        type: 'text';
        text: { content: string };
        annotations?: Record<string, unknown>;
      } = {
        type: 'text',
        text: { content: buf.join('') },
      };
      if (annotations) item.annotations = annotations;
      items.push(item);
      buf.length = 0;
      buf.push(ch);
      units = cu;
    } else {
      buf.push(ch);
      units += cu;
    }
  }

  if (buf.length > 0) {
    const item: { type: 'text'; text: { content: string }; annotations?: Record<string, unknown> } =
      {
        type: 'text',
        text: { content: buf.join('') },
      };
    if (annotations) item.annotations = annotations;
    items.push(item);
  }

  return items;
}

// ── Property extraction (read) ────────────────────────────────────────────────

type NotionPropertyValue = {
  type: string;
  [key: string]: unknown;
};

/**
 * Extract a human-readable scalar value from a Notion property object.
 * Used when presenting query results to the LLM.
 */
export function extractPropertyValue(prop: NotionPropertyValue): string {
  const t = prop.type;

  if (t === 'title') {
    const items = prop['title'] as Array<{ plain_text: string }> | undefined;
    return (items ?? []).map((p) => p.plain_text).join('');
  }
  if (t === 'rich_text') {
    const items = prop['rich_text'] as Array<{ plain_text: string }> | undefined;
    return (items ?? []).map((p) => p.plain_text).join('');
  }
  if (t === 'select') {
    const sel = prop['select'] as { name: string } | null | undefined;
    return sel?.name ?? '';
  }
  if (t === 'multi_select') {
    const items = prop['multi_select'] as Array<{ name: string }> | undefined;
    return (items ?? []).map((s) => s.name).join(', ');
  }
  if (t === 'status') {
    const st = prop['status'] as { name: string } | null | undefined;
    return st?.name ?? '';
  }
  if (t === 'number' || t === 'checkbox' || t === 'url' || t === 'email' || t === 'phone_number') {
    const val = prop[t];
    return val != null ? String(val) : '';
  }
  if (t === 'date') {
    const d = prop['date'] as { start: string; end?: string | null } | null | undefined;
    if (!d) return '';
    return d.end ? `${d.start} → ${d.end}` : d.start;
  }
  if (t === 'relation') {
    const items = prop['relation'] as Array<{ id: string }> | undefined;
    return (items ?? []).map((r) => r.id).join(', ');
  }
  if (t === 'formula') {
    const f = prop['formula'] as { type: string; [k: string]: unknown } | undefined;
    if (!f) return '';
    return String(f[f.type] ?? '');
  }
  if (t === 'rollup') {
    const r = prop['rollup'] as { type: string; [k: string]: unknown } | undefined;
    if (!r) return '';
    return String(r[r.type] ?? '');
  }
  if (t === 'people') {
    const people = prop['people'] as Array<{ name?: string; id: string }> | undefined;
    return (people ?? []).map((p) => p.name ?? p.id).join(', ');
  }
  if (t === 'created_time') return String(prop['created_time'] ?? '');
  if (t === 'last_edited_time') return String(prop['last_edited_time'] ?? '');

  return '';
}

// ── Property building (write) ─────────────────────────────────────────────────

type DbSchema = Record<string, { type: string }>;

/**
 * Convert a simple key-value pair to a Notion property format object.
 * Uses schema type if available; falls back to type inference from value.
 */
export function buildNotionProperty(
  name: string,
  value: unknown,
  dbSchema: DbSchema | null,
): Record<string, unknown> {
  const knownType = dbSchema?.[name]?.type;

  let propType: string;
  if (knownType) {
    propType = knownType;
  } else if (typeof value === 'boolean') {
    propType = 'checkbox';
  } else if (typeof value === 'number') {
    propType = 'number';
  } else if (typeof value === 'string' && value.startsWith('http')) {
    propType = 'url';
  } else {
    propType = 'rich_text';
  }

  switch (propType) {
    case 'title':
      return { title: chunkRichText(String(value ?? '')) };
    case 'rich_text':
      return { rich_text: chunkRichText(String(value ?? '')) };
    case 'number': {
      const n = Number(value);
      return isNaN(n) ? { rich_text: chunkRichText(String(value)) } : { number: n };
    }
    case 'checkbox':
      return { checkbox: Boolean(value) };
    case 'url':
      return { url: value != null ? String(value).slice(0, 2000) : null };
    case 'select':
      return { select: { name: String(value).slice(0, 100) } };
    case 'multi_select': {
      const vals = Array.isArray(value) ? value : String(value).split(',');
      return { multi_select: vals.map((v: unknown) => ({ name: String(v).trim().slice(0, 100) })) };
    }
    case 'date':
      return { date: { start: String(value) } };
    case 'email':
      return { email: String(value) };
    case 'phone_number':
      return { phone_number: String(value) };
    default:
      return { rich_text: chunkRichText(String(value ?? '')) };
  }
}

// ── Title extraction ──────────────────────────────────────────────────────────

type NotionPageOrDb = {
  properties?: Record<string, NotionPropertyValue>;
  title?: Array<{ plain_text: string }>;
};

/**
 * Extract the plain-text title from a Notion page or database object.
 */
export function extractTitle(obj: NotionPageOrDb): string {
  const props = obj.properties ?? {};
  for (const prop of Object.values(props)) {
    if (prop.type === 'title') {
      const items = prop['title'] as Array<{ plain_text: string }> | undefined;
      return (items ?? []).map((p) => p.plain_text).join('');
    }
  }
  // Fallback for database objects where title is a top-level array
  const titleArr = obj.title;
  if (Array.isArray(titleArr)) {
    return titleArr.map((p) => p.plain_text).join('');
  }
  return '(untitled)';
}
