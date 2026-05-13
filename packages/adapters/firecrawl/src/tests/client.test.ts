// @nodal-agents/adapter-firecrawl — client factory tests

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFirecrawlClient } from '../client.ts';
import { FirecrawlApiError } from '../errors.ts';

const FAKE_KEY = 'fc-fake_api_key_123';

describe('createFirecrawlClient — instantiation', () => {
  it('creates a client without throwing', () => {
    expect(() => createFirecrawlClient(FAKE_KEY)).not.toThrow();
  });

  it('creates distinct client instances per call', () => {
    const a = createFirecrawlClient('key-a');
    const b = createFirecrawlClient('key-b');
    expect(a).not.toBe(b);
  });

  it('client has scrape, map, search, startCrawl, getCrawlStatus methods', () => {
    const client = createFirecrawlClient(FAKE_KEY);
    expect(typeof client.scrape).toBe('function');
    expect(typeof client.map).toBe('function');
    expect(typeof client.search).toBe('function');
    expect(typeof client.startCrawl).toBe('function');
    expect(typeof client.getCrawlStatus).toBe('function');
  });
});

describe('FirecrawlApiError — construction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('constructs with correct code and message', () => {
    const err = new FirecrawlApiError('firecrawl_unauthorized', 'Unauthorized', 401);
    expect(err.code).toBe('firecrawl_unauthorized');
    expect(err.message).toBe('Unauthorized');
    expect(err.status).toBe(401);
    expect(err.name).toBe('FirecrawlApiError');
    expect(err instanceof Error).toBe(true);
  });

  it('constructs without status', () => {
    const err = new FirecrawlApiError('firecrawl_unknown', 'network error');
    expect(err.status).toBeUndefined();
  });
});
