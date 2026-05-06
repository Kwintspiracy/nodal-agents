// channels/telegram.ts — sendTelegramMessage + bot config helpers via fetch

import { DeliveryError } from '../errors.ts';

export interface TelegramSendOpts {
  chatId: string;
  text: string;
  botToken: string;
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  disableWebPagePreview?: boolean;
}

interface TelegramApiResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramSendResult {
  message_id: number;
}

export interface TelegramBotInfo {
  id: number;
  username: string;
  firstName: string;
  canJoinGroups: boolean;
  canReadAllGroupMessages: boolean;
}

interface TelegramGetMeResult {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
}

export async function sendTelegramMessage(opts: TelegramSendOpts): Promise<{ messageId: number }> {
  const { chatId, text, botToken, parseMode, disableWebPagePreview } = opts;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
  };
  if (parseMode !== undefined) {
    body['parse_mode'] = parseMode;
  }
  if (disableWebPagePreview !== undefined) {
    body['disable_web_page_preview'] = disableWebPagePreview;
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new DeliveryError(
      'telegram_request_failed',
      `telegram_request_failed: network error: ${String(err)}`,
    );
  }

  const json = (await response.json()) as TelegramApiResponse<TelegramSendResult>;

  if (!response.ok || !json.ok) {
    const desc = json.description ?? '';
    if (response.status === 401) {
      throw new DeliveryError('telegram_unauthorized', `telegram_unauthorized: ${desc}`);
    }
    if (response.status === 429) {
      throw new DeliveryError('telegram_rate_limited', `telegram_rate_limited: ${desc}`);
    }
    if (response.status === 400 && desc.toLowerCase().includes('chat not found')) {
      throw new DeliveryError('telegram_chat_not_found', `telegram_chat_not_found: ${desc}`);
    }
    throw new DeliveryError('telegram_request_failed', `telegram_request_failed: ${desc}`);
  }

  const messageId = json.result?.message_id ?? 0;
  return { messageId };
}

// ─── Bot config helpers (used by dashboard to set up agents) ──────────────────
//
// These hit the same `https://api.telegram.org/bot<token>/<method>` endpoints
// but are read/admin operations, not message sends. They share the auth surface
// (the bot token IS the credential) so they live in the same module.

async function callBotApi<T>(
  botToken: string,
  method: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : '{}',
      signal,
    });
  } catch (err) {
    throw new DeliveryError(
      'telegram_request_failed',
      `telegram_request_failed: network error: ${String(err)}`,
    );
  }

  const json = (await response.json().catch(() => ({}))) as TelegramApiResponse<T>;

  if (!response.ok || !json.ok) {
    const desc = json.description ?? '';
    if (response.status === 401) {
      throw new DeliveryError('telegram_invalid_token', `telegram_invalid_token: ${desc}`);
    }
    if (response.status === 404) {
      // Telegram returns 404 with `Not Found` when the token shape is valid but
      // doesn't match any bot.
      throw new DeliveryError('telegram_invalid_token', `telegram_invalid_token: ${desc}`);
    }
    throw new DeliveryError('telegram_request_failed', `telegram_request_failed: ${desc}`);
  }

  if (json.result === undefined) {
    throw new DeliveryError(
      'telegram_request_failed',
      `telegram_request_failed: no result in response`,
    );
  }
  return json.result;
}

/**
 * Validate a bot token by calling Telegram's getMe.
 * Throws `telegram_invalid_token` on auth failure.
 */
export async function getTelegramBotInfo(botToken: string): Promise<TelegramBotInfo> {
  const result = await callBotApi<TelegramGetMeResult>(botToken, 'getMe');
  return {
    id: result.id,
    username: result.username,
    firstName: result.first_name,
    canJoinGroups: result.can_join_groups ?? false,
    canReadAllGroupMessages: result.can_read_all_group_messages ?? false,
  };
}

// ─── Long-polling helpers ─────────────────────────────────────────────────────
//
// NodalAI runs locally — no public URL — so we receive Telegram updates by
// long-polling getUpdates rather than by webhook. The runner spawns one poll
// loop per configured agent.

/** A single Telegram update — minimal shape we care about. */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id?: number; type?: string };
    from?: { id?: number; first_name?: string; username?: string; is_bot?: boolean };
    reply_to_message?: { from?: { is_bot?: boolean } };
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id?: number; first_name?: string; username?: string };
  };
}

/**
 * Long-poll Telegram for new updates. `offset` is the `update_id + 1` of the
 * last update we processed; pass `0` to fetch from scratch (useful on first
 * boot — Telegram retains a 24h backlog).
 *
 * `timeout` is in seconds (Telegram parameter), capped at 50 by the API.
 * The HTTP request blocks for up to `timeout` seconds waiting for new data,
 * so callers should expect this call to take a while.
 */
export async function getTelegramUpdates(opts: {
  botToken: string;
  offset: number;
  timeout?: number;
  /** Cap on number of updates returned. Telegram allows 1..100, default 100. */
  limit?: number;
  /** Abort the long-poll request (e.g. on runner shutdown). */
  signal?: AbortSignal;
}): Promise<TelegramUpdate[]> {
  const body: Record<string, unknown> = {
    offset: opts.offset,
    timeout: opts.timeout ?? 25,
    allowed_updates: ['message', 'callback_query'],
  };
  if (opts.limit !== undefined) body['limit'] = opts.limit;
  const result = await callBotApi<TelegramUpdate[]>(opts.botToken, 'getUpdates', body, opts.signal);
  return result;
}
