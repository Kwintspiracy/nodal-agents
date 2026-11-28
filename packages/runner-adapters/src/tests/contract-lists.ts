// contract-lists.ts — three-page provider fixtures of the operations declared `list`.
//
// Each fixture is the provider holding nine items on three pages, answering
// in its own pagination protocol (Drive's `pageToken`, Notion's
// `start_cursor`, Graph's `@odata.nextLink`, Airtable's `offset`). With
// `bigItems`, every item carries 9,000 characters, so one page no longer fits
// the result the model reads: the contract must cut it on whole items, say
// so, and resume where it stopped.

import type { ListFixture } from '@nodal-agents/test-kit/connector-contract-suite';

const PAGES = [
  ['item-a1', 'item-a2', 'item-a3'],
  ['item-b1', 'item-b2', 'item-b3'],
  ['item-c1', 'item-c2', 'item-c3'],
] as const;

const BIG = 'x'.repeat(9_000);

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** The page index a provider cursor names (`p2` → 1), the first page without one. */
function pageIndex(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const m = /^p(\d)$/.exec(cursor);
  if (!m) throw new Error(`fake provider: unknown cursor ${cursor}`);
  return Number(m[1]) - 1;
}

function nextCursor(index: number, pages: readonly (readonly string[])[]): string | null {
  return index + 1 < pages.length ? `p${index + 2}` : null;
}

const DRIVE_LIST: ListFixture = {
  pages: PAGES,
  answer: (req, pages, big) => {
    const i = pageIndex(new URL(req.url).searchParams.get('pageToken'));
    const next = nextCursor(i, pages);
    return json({
      files: pages[i]!.map((id) => ({
        id,
        name: big ? `${id} ${BIG}` : id,
        mimeType: 'text/plain',
        modifiedTime: '2026-11-20T10:00:00.000Z',
        size: '12',
      })),
      ...(next ? { nextPageToken: next } : {}),
    });
  },
  idOf: (item) => (item as { id: string }).id,
};

const NOTION_QUERY: ListFixture = {
  pages: PAGES,
  answer: async (req, pages, big) => {
    const body = JSON.parse((await req.text()) || '{}') as { start_cursor?: string };
    const i = pageIndex(body.start_cursor);
    const next = nextCursor(i, pages);
    return json({
      object: 'list',
      results: pages[i]!.map((id) => ({
        object: 'page',
        id,
        url: `https://www.notion.so/${id}`,
        properties: {
          Name: { type: 'title', title: [{ plain_text: big ? `${id} ${BIG}` : id }] },
        },
      })),
      has_more: next !== null,
      next_cursor: next,
    });
  },
  idOf: (item) => (item as { id: string }).id,
};

const OUTLOOK_MESSAGES: ListFixture = {
  pages: PAGES,
  answer: (req, pages, big) => {
    const skip = Number(new URL(req.url).searchParams.get('$skip') ?? '0');
    const i = skip / 3;
    const more = i + 1 < pages.length;
    return json({
      value: pages[i]!.map((id) => ({
        id,
        subject: id,
        bodyPreview: big ? BIG : 'preview',
        receivedDateTime: '2026-11-20T10:00:00Z',
        from: { emailAddress: { address: 'someone@example.com' } },
        isRead: false,
        hasAttachments: false,
        parentFolderId: 'inbox',
      })),
      ...(more
        ? {
            '@odata.nextLink': `https://graph.microsoft.com/v1.0/me/messages?$top=3&$skip=${(i + 1) * 3}`,
          }
        : {}),
    });
  },
  idOf: (item) => (item as { messageId: string }).messageId,
};

const AIRTABLE_RECORDS: ListFixture = {
  pages: PAGES,
  answer: (req, pages, big) => {
    const i = pageIndex(new URL(req.url).searchParams.get('offset'));
    const next = nextCursor(i, pages);
    return json({
      records: pages[i]!.map((id) => ({
        id,
        fields: { Name: big ? `${id} ${BIG}` : id },
        createdTime: '2026-11-20T10:00:00.000Z',
      })),
      ...(next ? { offset: next } : {}),
    });
  },
  idOf: (item) => (item as { id: string }).id,
};

export const CONTRACT_LIST_FIXTURES: Readonly<
  Record<string, Readonly<Record<string, ListFixture>>>
> = {
  'google-drive': { drive_list_files: DRIVE_LIST },
  notion: { notion_query_database: NOTION_QUERY },
  'notion-oauth': { notion_query_database: NOTION_QUERY },
  'outlook-mail': { outlook_list_messages: OUTLOOK_MESSAGES },
  airtable: { airtable_list_records: AIRTABLE_RECORDS },
  'airtable-oauth': { airtable_list_records: AIRTABLE_RECORDS },
};
