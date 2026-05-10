import { describe, it, expect } from 'vitest';
import { OAUTH_GUIDES, APIKEY_GUIDES } from '../connector-help.ts';
import type { Guide } from '../connector-help.ts';

// ─── Structural helpers ───────────────────────────────────────────────────────

function assertGuide(guide: Guide, context: string) {
  expect(guide.title, `${context}: title must be non-empty`).toBeTruthy();

  // Steps must be numbered sequentially starting at 1.
  guide.steps.forEach((step, idx) => {
    expect(step.number, `${context}: step[${idx}].number must be ${idx + 1}`).toBe(idx + 1);
    expect(step.text.trim(), `${context}: step[${idx}].text must be non-empty`).toBeTruthy();

    // Every URL in link.href must parse as a valid URL.
    if (step.link) {
      expect(
        () => new URL(step.link!.href),
        `${context}: step[${idx}].link.href is invalid URL`,
      ).not.toThrow();
      expect(
        step.link.label.trim(),
        `${context}: step[${idx}].link.label must be non-empty`,
      ).toBeTruthy();
    }

    // Sub-links must also parse.
    if (step.subLinks) {
      step.subLinks.forEach((sl, slIdx) => {
        expect(
          () => new URL(sl.href),
          `${context}: step[${idx}].subLinks[${slIdx}].href is invalid URL`,
        ).not.toThrow();
        expect(
          sl.label.trim(),
          `${context}: step[${idx}].subLinks[${slIdx}].label must be non-empty`,
        ).toBeTruthy();
      });
    }
  });
}

// ─── OAUTH_GUIDES ─────────────────────────────────────────────────────────────

describe('OAUTH_GUIDES', () => {
  it('has exactly 3 entries', () => {
    expect(Object.keys(OAUTH_GUIDES)).toHaveLength(3);
    expect(Object.keys(OAUTH_GUIDES)).toEqual(
      expect.arrayContaining(['google-oauth', 'notion-oauth', 'airtable-oauth']),
    );
  });

  it('google-oauth: sequential steps, valid URLs, format hint present', () => {
    const guide = OAUTH_GUIDES['google-oauth'];
    assertGuide(guide, 'google-oauth');
    expect(guide.format, 'google-oauth: format hint required').toBeTruthy();
    expect(guide.format).toMatch(/apps\.googleusercontent\.com/);
  });

  it('google-oauth: step 2 has 4 subLinks (one per Google API)', () => {
    const step2 = OAUTH_GUIDES['google-oauth'].steps[1];
    expect(step2?.subLinks).toHaveLength(4);
    const hrefs = step2!.subLinks!.map((sl) => sl.href);
    expect(hrefs).toContain('https://console.cloud.google.com/apis/library/drive.googleapis.com');
    expect(hrefs).toContain('https://console.cloud.google.com/apis/library/gmail.googleapis.com');
    expect(hrefs).toContain('https://console.cloud.google.com/apis/library/sheets.googleapis.com');
    expect(hrefs).toContain('https://console.cloud.google.com/apis/library/docs.googleapis.com');
  });

  it('notion-oauth: sequential steps, valid URLs, format hint present', () => {
    const guide = OAUTH_GUIDES['notion-oauth'];
    assertGuide(guide, 'notion-oauth');
    expect(guide.format, 'notion-oauth: format hint required').toBeTruthy();
    expect(guide.format).toMatch(/secret_/);
  });

  it('airtable-oauth: sequential steps, valid URLs', () => {
    const guide = OAUTH_GUIDES['airtable-oauth'];
    assertGuide(guide, 'airtable-oauth');
  });

  it('airtable-oauth: warning mentions LAN-IP / localhost constraint and is gated lan-ip-only', () => {
    const guide = OAUTH_GUIDES['airtable-oauth'];
    expect(guide.warning, 'airtable-oauth: warning required').toBeTruthy();
    expect(guide.warning).toMatch(/localhost/i);
    expect(guide.warningWhen, 'airtable-oauth: warning must be gated lan-ip-only').toBe(
      'lan-ip-only',
    );
  });
});

// ─── APIKEY_GUIDES ────────────────────────────────────────────────────────────

describe('APIKEY_GUIDES', () => {
  it('has exactly 5 entries', () => {
    expect(Object.keys(APIKEY_GUIDES)).toHaveLength(5);
    expect(Object.keys(APIKEY_GUIDES)).toEqual(
      expect.arrayContaining(['notion', 'airtable', 'apify', 'firecrawl', 'tavily']),
    );
  });

  it('notion: sequential steps, valid URLs, format hint starts with secret_', () => {
    const guide = APIKEY_GUIDES['notion'];
    assertGuide(guide, 'notion');
    expect(guide.format).toBeTruthy();
    expect(guide.format).toMatch(/secret_/);
  });

  it('airtable: sequential steps, valid URLs, format hint starts with pat', () => {
    const guide = APIKEY_GUIDES['airtable'];
    assertGuide(guide, 'airtable');
    expect(guide.format).toBeTruthy();
    expect(guide.format).toMatch(/pat/);
  });

  it('apify: sequential steps, valid URLs, format hint starts with apify_api_', () => {
    const guide = APIKEY_GUIDES['apify'];
    assertGuide(guide, 'apify');
    expect(guide.format).toBeTruthy();
    expect(guide.format).toMatch(/apify_api_/);
  });

  it('firecrawl: sequential steps, valid URLs, format hint starts with fc-', () => {
    const guide = APIKEY_GUIDES['firecrawl'];
    assertGuide(guide, 'firecrawl');
    expect(guide.format).toBeTruthy();
    expect(guide.format).toMatch(/fc-/);
  });

  it('tavily: sequential steps, valid URLs, format hint starts with tvly-', () => {
    const guide = APIKEY_GUIDES['tavily'];
    assertGuide(guide, 'tavily');
    expect(guide.format).toBeTruthy();
    expect(guide.format).toMatch(/tvly-/);
  });
});
