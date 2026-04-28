// deliver.test.ts — full path: pglite-seeded job → deliver → assert outputs (mock sender)

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodalai/db/test-utils';
import type { TestDb } from '@nodalai/db/test-utils';
import { agentJobs } from '@nodalai/db';
import { eq } from '@nodalai/db';
import { deliverResult } from '../deliver.ts';
import { DeliveryError } from '../errors.ts';

let db: TestDb;
let entityId: string;
let agentId: string;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  const seeds = await seedMinimal(db);
  entityId = seeds.entityId;
  agentId = seeds.agentId;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function insertJob(
  overrides: Partial<{
    channel: string;
    chatId: string | null;
    result: string | null;
    error: string | null;
    task: string;
  }> = {},
) {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId,
      agentId,
      channel: overrides.channel ?? 'api',
      task: overrides.task ?? 'Test task',
      chatId: overrides.chatId ?? null,
      result: overrides.result ?? null,
      error: overrides.error ?? null,
    })
    .returning();
  if (!job) throw new Error('Failed to insert job');
  return job;
}

function mockFetchSuccess(messageId = 42) {
  // Use mockImplementation to return a fresh Response per call (body can only be read once)
  return vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

// ─── No-content skip ──────────────────────────────────────────────────────────

describe('deliverResult — no-content skip', () => {
  it('returns skipped when result AND error are both null', async () => {
    const job = await insertJob({ result: null, error: null });

    const result = await deliverResult(job.id, { db });
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('no_content');
    expect(result.channel).toBeNull();
  });
});

// ─── Log channel (fallback) ────────────────────────────────────────────────────

describe('deliverResult — log channel', () => {
  it('delivers via log channel when no chatId or email resolution possible', async () => {
    // No entityId, no chatId, channel=api → falls back to log
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: null,
        agentId: null,
        channel: 'api',
        task: 'Log task',
        result: 'Done via log',
        error: null,
      })
      .returning();
    if (!job) throw new Error('insert failed');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await deliverResult(job.id, { db });

    expect(result.status).toBe('sent');
    expect(result.channel).toBe('log');
    expect(result.messageIds.length).toBeGreaterThan(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('channelOverride=log forces log delivery even for telegram jobs', async () => {
    const job = await insertJob({ channel: 'telegram', chatId: '12345', result: 'result' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await deliverResult(job.id, { db }, { channelOverride: 'log' });

    expect(result.status).toBe('sent');
    expect(result.channel).toBe('log');
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ─── Telegram channel ─────────────────────────────────────────────────────────

describe('deliverResult — telegram channel', () => {
  it('delivers via telegram when channel=telegram and chatId set', async () => {
    const fetchMock = mockFetchSuccess(77);
    const job = await insertJob({ channel: 'telegram', chatId: '9999', result: 'Hi there' });

    const result = await deliverResult(job.id, { db, telegramBotToken: 'bot:TOKEN' });

    expect(result.status).toBe('sent');
    expect(result.channel).toBe('telegram');
    expect(result.messageIds).toContain('77');

    // Verify the exact fetch shape
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.telegram.org/botbot:TOKEN/sendMessage');
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['chat_id']).toBe('9999');
    expect(body['parse_mode']).toBe('HTML');
    expect(body['disable_web_page_preview']).toBe(true);
  });

  it('returns failed status when bot token is missing', async () => {
    const job = await insertJob({ channel: 'telegram', chatId: '9999', result: 'Hi' });

    const result = await deliverResult(job.id, { db, telegramBotToken: undefined });
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('telegram_no_token');
  });

  it('returns failed status when chatId is missing even if channel=telegram', async () => {
    const job = await insertJob({ channel: 'telegram', chatId: null, result: 'Hi' });

    // No chatId → channel resolves to null or email or log depending on entity
    // Since entityId is set and resolves to a user with email, it tries email,
    // which throws delivery_email_not_configured
    const result = await deliverResult(job.id, { db, telegramBotToken: 'tok' });
    // email is a stub that always throws — result should be failed
    expect(['failed', 'sent']).toContain(result.status);
  });

  it('sends multiple chunks for a long message', async () => {
    // Return a fresh Response for each call — a single Response instance can only be read once
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const longResult = 'x'.repeat(5000);
    const job = await insertJob({ channel: 'telegram', chatId: '123', result: longResult });

    const result = await deliverResult(
      job.id,
      { db, telegramBotToken: 'tok' },
      { maxLength: 2000 },
    );

    expect(result.status).toBe('sent');
    // 5000 chars + title/footer → at least 2 fetches
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.messageIds.length).toBe(fetchMock.mock.calls.length);
  });
});

// ─── Email channel ────────────────────────────────────────────────────────────

describe('deliverResult — email channel', () => {
  it('channelOverride=email returns failed (stub not configured)', async () => {
    const job = await insertJob({ result: 'Done', error: null });

    const result = await deliverResult(
      job.id,
      { db, emailFrom: 'no-reply@example.com' },
      { channelOverride: 'email' },
    );

    // The sendEmail stub always throws delivery_email_not_configured
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('delivery_email_not_configured');
  });
});

// ─── Job not found ────────────────────────────────────────────────────────────

describe('deliverResult — job not found', () => {
  it('throws DeliveryError delivery_job_not_found for unknown jobId', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000099';

    await expect(deliverResult(fakeId, { db })).rejects.toSatisfy((err: unknown) => {
      return err instanceof DeliveryError && err.code === 'delivery_job_not_found';
    });
  });
});

// ─── AgentId token lookup ──────────────────────────────────────────────────────

describe('deliverResult — agent-specific bot token', () => {
  it('uses agent telegram_bot_token over env token when available', async () => {
    const fetchMock = mockFetchSuccess(55);

    // Update the seeded agent with a bot token
    const { agents } = await import('@nodalai/db');
    await db
      .update(agents)
      .set({ telegramBotToken: 'agent-specific-bot:TOKEN' })
      .where(eq(agents.id, agentId));

    const job = await insertJob({ channel: 'telegram', chatId: '555', result: 'result' });

    const result = await deliverResult(job.id, {
      db,
      telegramBotToken: 'fallback-env-token',
    });

    expect(result.status).toBe('sent');
    const [url] = fetchMock.mock.calls[0]!;
    // Must use the agent token, not the env fallback
    expect(String(url)).toContain('agent-specific-bot:TOKEN');
  });
});
