// oauth-scopes.test.ts — CONNECTOR-001 (audit vague D).
//
// Four Google connectors asked for the widest scope in their family. Two facts
// came out of looking at what their tools actually call:
//
//   - Calendar did NOT need it. Its whole API surface is events.*,
//     calendarList.list and freebusy.query, none of which require the blanket
//     `auth/calendar` that also grants deleting calendars.
//   - Drive, Sheets and Docs DO need it. `drive.file` cannot open a file the
//     user already has, and the `.readonly` variants cannot write — narrowing
//     them would delete the connectors' reason to exist.
//
// So the rule this file enforces is not "always narrow". It is: a connector may
// only reach further than its name implies if it SAYS SO, in the product's own
// words, before the user reaches the provider's consent screen.

import { describe, it, expect } from 'vitest';
import { OAUTH_PROVIDERS } from '../oauth/providers';
import { CONNECTOR_CATALOG } from '../connector-catalog';

/** Scopes that reach every object of their kind in the user's account. */
const BLANKET_SCOPES = new Set([
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/calendar',
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.modify',
]);

describe('google-calendar scopes', () => {
  const scopes = OAUTH_PROVIDERS['google-calendar']!.scopes;

  it('no longer asks for the blanket calendar scope', () => {
    // The old value. With it, a stolen token could DELETE a calendar outright.
    expect(scopes).not.toContain('https://www.googleapis.com/auth/calendar');
  });

  it('still covers every call its tools actually make', () => {
    // events.{list,get,insert,patch,delete}
    expect(scopes).toContain('https://www.googleapis.com/auth/calendar.events');
    // calendarList.list — NOT granted by calendar.events, hence its own scope.
    expect(scopes).toContain('https://www.googleapis.com/auth/calendar.calendarlist.readonly');
    // freebusy.query — named rather than assumed to be implied.
    expect(scopes).toContain('https://www.googleapis.com/auth/calendar.freebusy');
  });
});

describe('gmail scopes', () => {
  it('stays narrow — read + send, never modify or full mailbox', () => {
    // Already correct before the audit; pinned so it cannot drift wider.
    const scopes = OAUTH_PROVIDERS['gmail']!.scopes;
    expect(scopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(scopes).toContain('https://www.googleapis.com/auth/gmail.send');
    expect(scopes).not.toContain('https://www.googleapis.com/auth/gmail.modify');
    expect(scopes).not.toContain('https://mail.google.com/');
  });
});

describe('blanket scopes must be disclosed', () => {
  const catalogBySlug = new Map(CONNECTOR_CATALOG.map((c) => [c.slug, c]));

  it.each(Object.keys(OAUTH_PROVIDERS))('%s', (slug) => {
    const provider = OAUTH_PROVIDERS[slug]!;
    const blanket = provider.scopes.filter((s) => BLANKET_SCOPES.has(s));
    if (blanket.length === 0) return;

    const entry = catalogBySlug.get(slug);
    expect(entry, `${slug} requests ${blanket.join(', ')} but is not in the catalog`).toBeDefined();
    // The disclosure is the whole mitigation for a scope we cannot narrow.
    // Without it the user reads "connect Google Drive" and gets all of it.
    expect(
      entry!.scopeDisclosure,
      `${slug} requests the blanket scope ${blanket.join(', ')} and MUST disclose its reach ` +
        `in connector-catalog.ts (CONNECTOR-001)`,
    ).toBeTruthy();
  });

  it('the connectors that still need a blanket scope are exactly the three known ones', () => {
    // A new entry landing here is not automatically wrong — but it is a
    // decision someone has to make on purpose, not inherit by copy-paste.
    const withBlanket = Object.entries(OAUTH_PROVIDERS)
      .filter(([, p]) => p.scopes.some((s) => BLANKET_SCOPES.has(s)))
      .map(([slug]) => slug)
      .sort();
    expect(withBlanket).toEqual(['google-docs', 'google-drive', 'google-sheets']);
  });
});
