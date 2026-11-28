// continuation-fields.ts — values a model must read exactly to continue its work.
//
// A list operation returns where to continue (a page token, a cursor, a sync
// token), and a resource returns what names it (an id, an ETag, an upload
// URL): the model hands them back on its next call. They sit in fields whose
// names say "token" or "key", and none of them is a credential. A boundary in
// front of the model that hid them would stop an agent at the first page.
//
// Each entry is a field as a provider returns it. The values are invented, in
// the forms the providers use.

export interface ContinuationSample {
  /** Who returns it, and where. */
  readonly what: string;
  /** The field's name, as the provider writes it. */
  readonly field: string;
  /** Its value: what the model must hand back unchanged. */
  readonly value: string;
}

export const CONTINUATION_SAMPLES: readonly ContinuationSample[] = [
  { what: 'a list page token', field: 'nextPageToken', value: 'CAESBggDEAEYAQ' },
  {
    what: 'a long page token',
    field: 'nextPageToken',
    value: 'AJD0b7dEv3T2PqZ9kLmN4xR8sW1cY6uF0hG5jK3aB7eD9fH2iL4mN6oP8qR0sT',
  },
  { what: 'a sync token', field: 'nextSyncToken', value: 'CPDAlvWDx70CEPDAlvWDx70CGAU=' },
  { what: 'a page cursor', field: 'next_cursor', value: 'dXNlcjpVMEc5V0ZYTlo=' },
  { what: 'a continuation token', field: 'continuationToken', value: 'eyJvZmZzZXQiOjUwfQ' },
  {
    what: 'a pagination token',
    field: 'pagination_token',
    value: '7140dibdnow9c7btw3w29grvxfcgvpb9n9coehpk7xz5i',
  },
  { what: 'a history id', field: 'historyId', value: '1874092' },
  { what: 'an entity tag', field: 'etag', value: '"3298123476459000"' },
  { what: 'a resource id', field: 'id', value: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms' },
  {
    what: 'a next-page link',
    field: 'nextLink',
    value: 'https://api.example.com/v1/items?pageToken=Q0FFU0JnZ0RFQUVZQVE&limit=50',
  },
  {
    what: 'a resumable upload URL',
    field: 'location',
    value:
      'https://upload.example.com/v1/files?uploadType=resumable&upload_id=ABPtcPpLq3k9ZxW2rT7mN',
  },
  { what: 'a session key of a page', field: 'resumeKey', value: 'page-0003-of-0012' },
];

/** The samples as structured data, one object per field, as an API's body carries them. */
export function continuationObjects(): Array<Record<string, string>> {
  return CONTINUATION_SAMPLES.map((s) => ({ [s.field]: s.value }));
}

/** The same, as the JSON text an MCP server or a command prints. */
export function continuationJson(): string {
  return JSON.stringify({ items: continuationObjects() }, null, 2);
}

/**
 * Does `text` hold `sample`'s field and value, as a JSON text writes them
 * (`"field": "value"`), once the layers of JSON string escaping a result is
 * wrapped in (a tool's text inside a JSON row, inside a request) are undone?
 */
export function holdsContinuation(text: string, sample: ContinuationSample): boolean {
  const needle = `${JSON.stringify(sample.field)}: ${JSON.stringify(sample.value)}`;
  const compact = `${JSON.stringify(sample.field)}:${JSON.stringify(sample.value)}`;
  let t = text;
  for (let layer = 0; layer < 4; layer++) {
    if (t.includes(needle) || t.includes(compact)) return true;
    t = t.replace(/\\(["\\])/g, '$1').replace(/\\n/g, '\n');
  }
  return t.includes(needle) || t.includes(compact);
}

/** The samples as plain text, one `field: value` per line. */
export function continuationText(): string {
  return CONTINUATION_SAMPLES.map((s) => `${s.field}: ${s.value}`).join('\n');
}
