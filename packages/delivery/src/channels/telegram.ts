// channels/telegram.ts — sendTelegramMessage + bot config helpers via fetch

import { DeliveryError } from '../errors.ts';

/** Timeout for all outbound Telegram API calls (sendMessage, getMe, getUpdates). */
const TELEGRAM_TIMEOUT_MS = 10_000;

/** One inline-keyboard button. `callback_data` is sent back in a callback_query when tapped (≤64 bytes). */
export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

/** Inline keyboard: an array of button rows. */
export type TelegramInlineKeyboard = TelegramInlineButton[][];

export interface TelegramSendOpts {
  chatId: string;
  text: string;
  botToken: string;
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  disableWebPagePreview?: boolean;
  /**
   * Optional inline keyboard. When the text is chunked (>4096 chars) the keyboard
   * is attached to the LAST chunk only, so the buttons sit under the final message.
   */
  inlineKeyboard?: TelegramInlineKeyboard;
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

/** Telegram hard limit per message is 4096 chars; stay under it with a margin. */
const TELEGRAM_MAX_CHARS = 3900;

/**
 * Split text into Telegram-sized chunks (≤ TELEGRAM_MAX_CHARS), preferring to
 * break on paragraph/line boundaries so a message is never cut mid-line. A
 * single line longer than the limit is hard-split. Returns [text] when it fits.
 */
function chunkForTelegram(text: string, max = TELEGRAM_MAX_CHARS): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    // A single oversized line: flush current, then hard-split the line.
    if (line.length > max) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
      continue;
    }
    if (current.length + line.length + 1 > max) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Send a message to a Telegram chat. Text longer than Telegram's 4096-char limit
 * is automatically split into multiple messages (on line boundaries) — without
 * this, a long message fails with "Bad Request: message is too long" and the
 * delivery is silently lost. Returns the LAST message's id.
 */
export async function sendTelegramMessage(opts: TelegramSendOpts): Promise<{ messageId: number }> {
  const parts = chunkForTelegram(opts.text);
  let last = { messageId: 0 };
  for (let i = 0; i < parts.length; i += 1) {
    // Attach the inline keyboard to the final chunk only — buttons belong under
    // the last message, not repeated on every chunk.
    const isLast = i === parts.length - 1;
    last = await sendOneTelegramMessage({
      ...opts,
      text: parts[i] as string,
      inlineKeyboard: isLast ? opts.inlineKeyboard : undefined,
    });
  }
  return last;
}

async function sendOneTelegramMessage(opts: TelegramSendOpts): Promise<{ messageId: number }> {
  const { chatId, text, botToken, parseMode, disableWebPagePreview, inlineKeyboard } = opts;

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
  if (inlineKeyboard !== undefined) {
    body['reply_markup'] = { inline_keyboard: inlineKeyboard };
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new DeliveryError(
        'telegram_request_failed',
        `telegram_timeout: Telegram API did not respond within ${TELEGRAM_TIMEOUT_MS / 1000}s`,
      );
    }
    // Redact the bot token from any network error message (H-1)
    const safeMsg = String((err as Error).message ?? err).replaceAll(botToken, '[REDACTED]');
    throw new DeliveryError(
      'telegram_request_failed',
      `telegram_request_failed: network error: ${safeMsg}`,
    );
  } finally {
    clearTimeout(timeoutId);
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

// ─── Photo upload ─────────────────────────────────────────────────────────────

const PHOTO_TIMEOUT_MS = 30_000;

/**
 * Upload a photo (raw bytes) to a Telegram chat via sendPhoto.
 * Uses multipart/form-data — do NOT set Content-Type; fetch sets the boundary.
 */
export async function sendTelegramPhoto(opts: {
  chatId: string;
  botToken: string;
  photo: Uint8Array;
  filename?: string;
  caption?: string;
}): Promise<{ messageId: number }> {
  const { chatId, botToken, photo, filename, caption } = opts;

  const form = new FormData();
  form.append('chat_id', chatId);
  if (caption !== undefined) form.append('caption', caption.slice(0, 1024));
  // Use Buffer.from to get a concrete Uint8Array<ArrayBuffer> type so the Blob
  // constructor satisfies strict lib types (DOM BlobPart requires ArrayBuffer,
  // not the broader ArrayBufferLike which includes SharedArrayBuffer).
  const photoBlob = new Blob([Buffer.from(photo)]);
  form.append('photo', photoBlob, filename ?? 'image.png');

  const url = `https://api.telegram.org/bot${botToken}/sendPhoto`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PHOTO_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new DeliveryError(
        'telegram_request_failed',
        `telegram_timeout: Telegram API did not respond within ${PHOTO_TIMEOUT_MS / 1000}s`,
      );
    }
    const safeMsg = String((err as Error).message ?? err).replaceAll(botToken, '[REDACTED]');
    throw new DeliveryError(
      'telegram_request_failed',
      `telegram_request_failed: network error: ${safeMsg}`,
    );
  } finally {
    clearTimeout(timeoutId);
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

  return { messageId: json.result?.message_id ?? 0 };
}

// Documents can be up to 50 MB and slower to upload than a photo — give them
// a longer ceiling than sendPhoto.
const DOCUMENT_TIMEOUT_MS = 60_000;

/**
 * Upload an arbitrary file (raw bytes) to a Telegram chat via sendDocument.
 * Unlike sendPhoto, this accepts ANY file type (PDF, .md, .zip, .csv, …) and
 * delivers it as a downloadable attachment. Uses multipart/form-data — do NOT
 * set Content-Type; fetch sets the boundary.
 */
export async function sendTelegramDocument(opts: {
  chatId: string;
  botToken: string;
  document: Uint8Array;
  filename: string;
  caption?: string;
}): Promise<{ messageId: number }> {
  const { chatId, botToken, document, filename, caption } = opts;

  const form = new FormData();
  form.append('chat_id', chatId);
  if (caption !== undefined) form.append('caption', caption.slice(0, 1024));
  // Buffer.from yields a concrete Uint8Array<ArrayBuffer> for strict Blob types.
  const docBlob = new Blob([Buffer.from(document)]);
  form.append('document', docBlob, filename);

  const url = `https://api.telegram.org/bot${botToken}/sendDocument`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOCUMENT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new DeliveryError(
        'telegram_request_failed',
        `telegram_timeout: Telegram API did not respond within ${DOCUMENT_TIMEOUT_MS / 1000}s`,
      );
    }
    const safeMsg = String((err as Error).message ?? err).replaceAll(botToken, '[REDACTED]');
    throw new DeliveryError(
      'telegram_request_failed',
      `telegram_request_failed: network error: ${safeMsg}`,
    );
  } finally {
    clearTimeout(timeoutId);
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

  return { messageId: json.result?.message_id ?? 0 };
}

/**
 * Generic raw-bytes upload to a Telegram send* method (sendVideo / sendAudio /
 * sendVoice / …). Same multipart contract as sendPhoto/sendDocument — `field`
 * is the form field Telegram expects for that method ('video', 'audio', …).
 * Shared core so each new media type is a one-line wrapper, not a copy.
 */
async function uploadTelegramMedia(
  method: string,
  field: string,
  opts: {
    chatId: string;
    botToken: string;
    bytes: Uint8Array;
    filename: string;
    caption?: string;
  },
): Promise<{ messageId: number }> {
  const { chatId, botToken, bytes, filename, caption } = opts;

  const form = new FormData();
  form.append('chat_id', chatId);
  if (caption !== undefined) form.append('caption', caption.slice(0, 1024));
  form.append(field, new Blob([Buffer.from(bytes)]), filename);

  const url = `https://api.telegram.org/bot${botToken}/${method}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOCUMENT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', body: form, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new DeliveryError(
        'telegram_request_failed',
        `telegram_timeout: Telegram API did not respond within ${DOCUMENT_TIMEOUT_MS / 1000}s`,
      );
    }
    const safeMsg = String((err as Error).message ?? err).replaceAll(botToken, '[REDACTED]');
    throw new DeliveryError(
      'telegram_request_failed',
      `telegram_request_failed: network error: ${safeMsg}`,
    );
  } finally {
    clearTimeout(timeoutId);
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
  return { messageId: json.result?.message_id ?? 0 };
}

type TelegramMediaOpts = {
  chatId: string;
  botToken: string;
  bytes: Uint8Array;
  filename: string;
  caption?: string;
};

/** Send a video to a Telegram chat (inline player) via sendVideo. */
export function sendTelegramVideo(opts: TelegramMediaOpts): Promise<{ messageId: number }> {
  return uploadTelegramMedia('sendVideo', 'video', opts);
}

/** Send an audio track to a Telegram chat (music player) via sendAudio. */
export function sendTelegramAudio(opts: TelegramMediaOpts): Promise<{ messageId: number }> {
  return uploadTelegramMedia('sendAudio', 'audio', opts);
}

/** Send a voice note to a Telegram chat (voice bubble) via sendVoice (expects OGG/Opus). */
export function sendTelegramVoice(opts: TelegramMediaOpts): Promise<{ messageId: number }> {
  return uploadTelegramMedia('sendVoice', 'voice', opts);
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
  timeoutMs: number = TELEGRAM_TIMEOUT_MS,
): Promise<T> {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;

  // Combine caller-provided signal with a local timeout signal so every call
  // is bounded even if the caller passes no signal (e.g. getTelegramBotInfo).
  // Long-poll callers (getTelegramUpdates) override timeoutMs with a value
  // greater than the Telegram-side wait so we don't abort mid-poll.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  // If the caller also passes a signal, abort our controller when it fires.
  signal?.addEventListener('abort', () => controller.abort(), { once: true });

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : '{}',
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new DeliveryError(
        'telegram_request_failed',
        `telegram_timeout: Telegram API did not respond within ${timeoutMs / 1000}s`,
      );
    }
    // Redact the bot token from any network error message (H-1)
    const safeMsg = String((err as Error).message ?? err).replaceAll(botToken, '[REDACTED]');
    throw new DeliveryError(
      'telegram_request_failed',
      `telegram_request_failed: network error: ${safeMsg}`,
    );
  } finally {
    clearTimeout(timeoutId);
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

export interface TelegramFileDownload {
  bytes: Uint8Array;
  /** Lowercase extension WITHOUT the dot, derived from the file_path (e.g. 'jpg'). */
  ext: string;
}

/**
 * Download a Telegram file by its file_id: getFile resolves the file_path, then
 * we GET it from the file endpoint. Returns the raw bytes + a best-effort
 * extension. The bot token is the credential — redacted from any error message.
 */
export async function getTelegramFile(
  botToken: string,
  fileId: string,
): Promise<TelegramFileDownload> {
  const file = await callBotApi<{ file_path?: string }>(botToken, 'getFile', { file_id: fileId });
  const filePath = file.file_path;
  if (!filePath) {
    throw new DeliveryError(
      'telegram_request_failed',
      'telegram_request_failed: getFile returned no file_path',
    );
  }
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    const safeMsg = String((err as Error).message ?? err).replaceAll(botToken, '[REDACTED]');
    throw new DeliveryError(
      'telegram_request_failed',
      `telegram_request_failed: file download error: ${safeMsg}`,
    );
  } finally {
    clearTimeout(timeoutId);
  }
  if (!res.ok) {
    throw new DeliveryError(
      'telegram_request_failed',
      `telegram_request_failed: file download HTTP ${res.status}`,
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const ext = (filePath.split('.').pop() ?? 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  return { bytes, ext };
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
// Nodal-Agents runs locally — no public URL — so we receive Telegram updates by
// long-polling getUpdates rather than by webhook. The runner spawns one poll
// loop per configured agent.

/** A single Telegram update — minimal shape we care about. */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    text?: string;
    /** Caption accompanying a photo/document/video — where the user's words live
     *  when the message carries media instead of plain text. */
    caption?: string;
    /** Photo sizes, smallest → largest. The last entry is the highest resolution. */
    photo?: Array<{
      file_id: string;
      file_unique_id?: string;
      width?: number;
      height?: number;
      file_size?: number;
    }>;
    /** A file attachment (e.g. an image sent as a document to preserve quality). */
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    chat?: { id?: number; type?: string };
    from?: { id?: number; first_name?: string; username?: string; is_bot?: boolean };
    reply_to_message?: { from?: { is_bot?: boolean } };
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id?: number; first_name?: string; username?: string };
    /** The message the button is attached to — its chat is the authorization boundary. */
    message?: { message_id?: number; chat?: { id?: number; type?: string } };
  };
}

/**
 * Acknowledge a callback_query (button tap). Telegram shows the optional `text`
 * as a transient toast/alert to the user who tapped. MUST be called within ~10s
 * of receiving the callback or the client shows a spinner-then-error. Best-effort:
 * never throws (a failed ack must not block the decision that already happened).
 */
export async function answerTelegramCallback(
  botToken: string,
  callbackQueryId: string,
  text?: string,
  showAlert = false,
): Promise<void> {
  const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (text !== undefined) body['text'] = text;
  if (showAlert) body['show_alert'] = true;
  try {
    await callBotApi<boolean>(botToken, 'answerCallbackQuery', body);
  } catch {
    /* best-effort ack — the decision is already persisted */
  }
}

/**
 * Edit an existing message's text (and optionally its inline keyboard). Used to
 * turn an approval card into a resolved card ("✅ Approuvé") and strip its
 * buttons so it can't be tapped twice. Best-effort: never throws.
 */
export async function editTelegramMessageText(opts: {
  botToken: string;
  chatId: string | number;
  messageId: number;
  text: string;
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  inlineKeyboard?: TelegramInlineKeyboard;
}): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: opts.chatId,
    message_id: opts.messageId,
    text: opts.text,
  };
  if (opts.parseMode !== undefined) body['parse_mode'] = opts.parseMode;
  // Always send reply_markup: an explicit empty keyboard removes the buttons.
  body['reply_markup'] = { inline_keyboard: opts.inlineKeyboard ?? [] };
  try {
    await callBotApi<unknown>(opts.botToken, 'editMessageText', body);
  } catch {
    /* best-effort — the resolution already happened */
  }
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
  const longPollSeconds = opts.timeout ?? 25;
  const body: Record<string, unknown> = {
    offset: opts.offset,
    timeout: longPollSeconds,
    allowed_updates: ['message', 'callback_query'],
  };
  if (opts.limit !== undefined) body['limit'] = opts.limit;
  // Local timeout = Telegram-side wait + 5s network buffer. Without this override,
  // the default 10s timeout in callBotApi would abort every long-poll mid-flight.
  const longPollTimeoutMs = longPollSeconds * 1000 + 5_000;
  const result = await callBotApi<TelegramUpdate[]>(
    opts.botToken,
    'getUpdates',
    body,
    opts.signal,
    longPollTimeoutMs,
  );
  return result;
}
