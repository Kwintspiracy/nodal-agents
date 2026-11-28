// contract-providers.ts — the fake providers of the connector conformance suite.
//
// One fixture per registry entry: how that provider refuses for pace (every
// form it documents) and how it writes an error, in its own format. The
// answers are what the provider's API reference shows; no account is called.

import type { ProviderFixture } from '@nodal-agents/test-kit/connector-contract-suite';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Every Google API: the AIP-193 error model, JSON v1 form. */
const GOOGLE: ProviderFixture = {
  family: 'AIP-193 (Google APIs)',
  rateLimit: [
    {
      // Google's guides: a per-user rate refusal is a 403 with this reason, and no retry time.
      label: '403 rateLimitExceeded',
      retryAfterSeconds: null,
      answer: () =>
        json(403, {
          error: {
            code: 403,
            message: 'Rate Limit Exceeded',
            errors: [
              {
                message: 'Rate Limit Exceeded',
                domain: 'usageLimits',
                reason: 'rateLimitExceeded',
              },
            ],
            status: 'PERMISSION_DENIED',
          },
        }),
    },
    {
      label: '429 RESOURCE_EXHAUSTED with Retry-After',
      retryAfterSeconds: 120,
      answer: () =>
        json(
          429,
          {
            error: {
              code: 429,
              message: 'Quota exceeded',
              errors: [
                { message: 'Quota exceeded', domain: 'global', reason: 'rateLimitExceeded' },
              ],
              status: 'RESOURCE_EXHAUSTED',
            },
          },
          { 'retry-after': '120' },
        ),
    },
  ],
  error: (status, marker) =>
    json(status, {
      error: {
        code: status,
        message: `Not found: ${marker}`,
        errors: [{ message: marker, domain: 'global', reason: 'notFound' }],
        status: 'NOT_FOUND',
      },
    }),
};

const GRAPH: ProviderFixture = {
  family: 'Microsoft Graph',
  rateLimit: [
    {
      label: '429 TooManyRequests with Retry-After',
      retryAfterSeconds: 120,
      answer: () =>
        json(
          429,
          { error: { code: 'TooManyRequests', message: 'Too many requests' } },
          { 'retry-after': '120' },
        ),
    },
  ],
  error: (status, marker) =>
    json(status, {
      error: { code: 'ErrorItemNotFound', message: `The item was not found: ${marker}` },
    }),
};

const NOTION: ProviderFixture = {
  family: 'Notion',
  rateLimit: [
    {
      label: '429 rate_limited with Retry-After',
      retryAfterSeconds: 120,
      answer: () =>
        json(
          429,
          { object: 'error', status: 429, code: 'rate_limited', message: 'Rate limited' },
          { 'retry-after': '120' },
        ),
    },
  ],
  error: (status, marker) =>
    json(status, {
      object: 'error',
      status,
      code: 'object_not_found',
      message: `Could not find object: ${marker}`,
    }),
};

const AIRTABLE: ProviderFixture = {
  family: 'Airtable',
  rateLimit: [
    {
      // Airtable documents a 429 and a 30 s wait, without a header.
      label: '429 without Retry-After',
      retryAfterSeconds: null,
      answer: () =>
        json(429, { errors: [{ error: 'RATE_LIMIT_REACHED', message: 'Rate limit reached' }] }),
    },
  ],
  error: (status, marker) =>
    json(status, { error: { type: 'NOT_FOUND', message: `Could not find: ${marker}` } }),
};

const CLOUDFLARE: ProviderFixture = {
  family: 'Cloudflare API v4',
  rateLimit: [
    {
      label: '429 with Retry-After',
      retryAfterSeconds: 120,
      answer: () =>
        json(
          429,
          {
            success: false,
            errors: [{ code: 971, message: 'Please wait and consider throttling' }],
            messages: [],
            result: null,
          },
          { 'retry-after': '120' },
        ),
    },
  ],
  error: (status, marker) =>
    json(status, {
      success: false,
      errors: [{ code: 10007, message: `Not found: ${marker}` }],
      messages: [],
      result: null,
    }),
};

const APIFY: ProviderFixture = {
  family: 'Apify',
  rateLimit: [
    {
      label: '429 rate-limit-exceeded',
      retryAfterSeconds: null,
      answer: () =>
        json(429, { error: { type: 'rate-limit-exceeded', message: 'Rate limit exceeded' } }),
    },
  ],
  error: (status, marker) =>
    json(status, { error: { type: 'record-not-found', message: `Not found: ${marker}` } }),
};

const FIRECRAWL: ProviderFixture = {
  family: 'Firecrawl',
  rateLimit: [
    {
      label: '429 with Retry-After',
      retryAfterSeconds: 120,
      answer: () =>
        json(429, { success: false, error: 'Rate limit exceeded' }, { 'retry-after': '120' }),
    },
  ],
  error: (status, marker) => json(status, { success: false, error: `Not found: ${marker}` }),
};

const TAVILY: ProviderFixture = {
  family: 'Tavily',
  rateLimit: [
    {
      label: '429',
      retryAfterSeconds: null,
      answer: () => json(429, { detail: { error: 'Rate limit exceeded' } }),
    },
  ],
  error: (status, marker) => json(status, { detail: { error: `Not found: ${marker}` } }),
};

const POYO: ProviderFixture = {
  family: 'Poyo',
  rateLimit: [
    {
      label: '429 with Retry-After',
      retryAfterSeconds: 120,
      answer: () =>
        json(429, { code: 429, message: 'Too many requests' }, { 'retry-after': '120' }),
    },
  ],
  error: (status, marker) => json(status, { code: status, message: `Not found: ${marker}` }),
};

/** The fake provider of every registry entry. */
export const CONTRACT_PROVIDERS: Readonly<Record<string, ProviderFixture>> = {
  'google-drive': GOOGLE,
  gmail: GOOGLE,
  'google-calendar': GOOGLE,
  'google-sheets': GOOGLE,
  'google-docs': GOOGLE,
  'notion-oauth': NOTION,
  notion: NOTION,
  'outlook-mail': GRAPH,
  'airtable-oauth': AIRTABLE,
  airtable: AIRTABLE,
  firecrawl: FIRECRAWL,
  cloudflare: CLOUDFLARE,
  apify: APIFY,
  tavily: TAVILY,
  poyo: POYO,
};
